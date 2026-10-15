'use strict'

/* ════════════════════════════════════════════════════════════════
 * 打印机与云打印任务管理（云对象）
 *   依赖：printer（打印机配置集合）、print_task（打印任务集合）、
 *         order / order_item（只读出库单，打印内容以云端订单数据为准）
 *   推送：xprinter 芯烨云（xpyun-print）票据 = print 接口 + 80mm 小票版式
 *         （打样标签已改为蓝牙直连 TSPL，云标签通道 printLabel 已下线）
 *
 * 方法：
 *   bind({ sn, key, name, brand, enabled, isDefault })
 *                                                     绑定/更换打印机（仅仓管级；芯烨自动注册到芯烨账号）
 *   update({ id, name, enabled, isDefault })
 *                                                     局部更新（不改 sn/key，用于开关/改名/设默认）
 *   remove({ id })                                    删除打印机（删默认机时自动提新默认）
 *   list()                                            打印机列表（仅仓管级，不含 key）
 *   print({ id, no, times, sn })                       云推送出库/打样单小票（营业员仅限本人单）
 *   tasks({ orderId, orderNo })                       某单打印记录（与查看单同权限）
 *   query({ taskId })                                 回查任务是否已打印
 *
 * 换机说明：在「打印设置」重新绑定新机即可，其他代码无需改动。
 *   云打印只投 80mm 小票；历史 kind='label' 的标签机不接小票（标签走蓝牙，重绑后归一为票据机）。
 *
 * 权限口径与 outbound-manage 一致：admin/warehouse=仓管级；
 * 营业员等普通用户仅能查看/打印自己创建的单。
 * ════════════════════════════════════════════════════════════════ */

const xpyun = require('xpyun-print')

let _printer = null
let _task = null
let _order = null
let _item = null
const printerCol = () => {
	if (!_printer) _printer = uniCloud.database().collection('printer')
	return _printer
}
const taskCol = () => {
	if (!_task) _task = uniCloud.database().collection('print_task')
	return _task
}
const orderCol = () => {
	if (!_order) _order = uniCloud.database().collection('order')
	return _order
}
const itemCol = () => {
	if (!_item) _item = uniCloud.database().collection('order_item')
	return _item
}

/* ── 统一返回结构 / 鉴权：抽到 common/auth-common 公共模块 ── */
const { ok, fail, getActor, isStaff, isSalesRole, actorName } = require('auth-common')

/* 单行米数：优先 total_meters，兼容历史行 */
function rowMeters(row) {
	if (row.total_meters) return row.total_meters
	return parseFloat((row.rolls || []).reduce((s, v) => s + v, 0).toFixed(1))
}

/* ── 明细行 → 打印视图元素（与 outbound-manage.toItem 同口径） ── */
function toItem(row) {
	return {
		id: row._id,
		name: row.name || '',
		color: row.color || '',
		location: row.location || '',
		locations: Array.isArray(row.locations) ? row.locations : [],
		rolls: row.rolls || [],
		count: row.count || 0,
		total_meters: rowMeters(row),
		demandMeters: row.demand_meters || 0,
		demandCount: row.demand_count || 0,
		sampleCuts: Array.isArray(row.sample_cuts) ? row.sample_cuts : [],
		price: row.price === undefined || row.price === null ? undefined : Number(row.price),
		unit: row.unit === 'count' ? 'count' : row.unit === 'meters' ? 'meters' : undefined,
		amount: row.amount === undefined || row.amount === null ? undefined : Math.round(Number(row.amount) * 100) / 100,
	}
}

/* ── 主表 + 明细 → 打印聚合视图 ── */
function buildPrintView(order, rows) {
	const items = rows.map(toItem)
	return {
		no: order.no || '',
		customer: order.customer || '',
		operator: order.operator || '',
		date: order.date || '',
		time: order.time || '',
		status: order.status || '待确认',
		remark: order.remark || '',
		/** 收货地址（待确认单由客户资料自动带出、可手改）：票面在备注下方折行展示 */
		address: order.address || '',
		source: order.source || 'direct',
		count: items.reduce((s, it) => s + (it.count || it.rolls.length || 0), 0),
		total_meters: parseFloat(items.reduce((s, it) => s + (it.total_meters || 0), 0).toFixed(1)),
		items,
	}
}

/* 按 id 或单号查主表（id 优先） */
async function findOrder(id, no) {
	let res = null
	if (id) {
		res = await orderCol().doc(id).get()
	} else if (no) {
		res = await orderCol().where({ no }).limit(1).get()
	}
	return res && res.data && res.data[0] ? res.data[0] : null
}

/* 拉取某单全部明细（按创建时间升序）
 * limit(1000)：云函数端 get 默认上限 100 条，大单明细超 100 会导致票面打印内容缺失 */
async function loadItems(orderId) {
	if (!orderId) return []
	const res = await itemCol().where({ order_id: orderId }).orderBy('create_date', 'asc').limit(1000).get()
	return res.data
}


/* ── 默认机唯一化：把指定机设为默认，其余取消；换机后云打印自动指向新机。
 * 历史 kind='label' 标签机不参与（云标签通道已下线，重绑后归一为票据机） ── */
async function markDefault(id) {
	const cmd = uniCloud.database().command
	await printerCol().where({ kind: cmd.neq('label'), _id: cmd.neq(id) }).update({ is_default: false, update_date: Date.now() })
	await printerCol().doc(id).update({ is_default: true, update_date: Date.now() })
}

/* 读取芯烨云开发者配置（uni-config-center 插件 uni-xpyun） */
function xpyunConfig() {
	const configCenter = require('uni-config-center')
	const cfg = configCenter({ pluginId: 'uni-xpyun' }).config()
	return {
		user: cfg.user || '',
		userKey: cfg.userKey || '',
		apiBase: cfg.apiBase || '',
		timeout: Number(cfg.timeout) || 8000,
	}
}

/* ── 选目标打印机（云打印 = 80mm 小票）──
 * 历史 kind='label' 标签机不接小票（云标签通道已下线）
 * 顺序：sn 指定 → 默认机 → 最近启用机 → null（调用方报错引导绑定） */
async function pickPrinter({ sn }) {
	const cmd = uniCloud.database().command
	const slot = { kind: cmd.neq('label') }
	if (sn) {
		const r = await printerCol().where({ sn: String(sn), enabled: true, ...slot }).limit(1).get()
		if (r.data && r.data[0]) return r.data[0]
	}
	const d = await printerCol().where({ is_default: true, enabled: true, ...slot }).limit(1).get()
	if (d.data && d.data[0]) return d.data[0]
	const l = await printerCol().where({ enabled: true, ...slot }).orderBy('create_date', 'desc').limit(1).get()
	return l.data && l.data[0] ? l.data[0] : null
}

module.exports = {
	/* ── 绑定/更换打印机（仅仓管级）──
	 * 芯烨（xprinter）：填机身 SN/key → 自动注册到芯烨开发者账号 → 落库 → 切默认机。
	 *   注册失败不阻断落库（可能已在 admin.xpyun.net 手动添加过），返回值带 warning 供前端提示。 */
	async bind(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		if (!isStaff(actor.roles)) return fail('无打印设置权限')
		const { sn, key, name = '', brand = 'xprinter', enabled = true, isDefault = false } = params || {}
		const snText = String(sn || '').trim()
		if (!snText) return fail('缺少打印机 SN')
		const brandText = String(brand || '').trim() || 'xprinter'
		const keyText = String(key || '').trim()
		if (!keyText) return fail('缺少机身 key')
		const nameText = String(name).trim() || `芯烨云机 ${snText}`

		// 1) 品牌侧注册：芯烨走 addPrinters
		let warning = ''
		try {
			await xpyun.bindPrinter(xpyunConfig(), [{ sn: snText, name: nameText }])
		} catch (e) {
			warning = String((e && e.message) || e)
		}

		// 2) 落库（sn 唯一：已存在则更新，等价于「换机」）
		const exist = await printerCol().where({ sn: snText }).limit(1).get()
		const doc = {
			brand: brandText,
			key: keyText,
			name: nameText,
			// 统一票据机（云打印只投小票；标签走蓝牙直连，重绑把历史 label 机归一）
			kind: 'ticket',
			enabled: !!enabled,
			update_date: Date.now(),
		}
		let id = ''
		if (exist.data && exist.data.length) {
			id = exist.data[0]._id
			await printerCol().doc(id).update(doc)
		} else {
			const addRes = await printerCol().add({
				...doc,
				sn: snText,
				is_default: false,
				create_date: Date.now(),
			})
			id = addRes.id
		}

		// 3) 默认机：显式指定，或尚无默认机时自动接管（换机后自动切到新机）
		const defaultCount = await printerCol().where({ is_default: true, kind: uniCloud.database().command.neq('label') }).count()
		if (isDefault || defaultCount.total === 0) await markDefault(id)

		return ok({ id, sn: snText, brand: brandText, registered: !warning, warning })
	},

	/* ── 局部更新（不改 sn/key）：名称/启用/设为默认 ── */
	async update(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		if (!isStaff(actor.roles)) return fail('无打印设置权限')
		const { id, name, enabled, isDefault } = params || {}
		if (!id) return fail('缺少打印机id')
		const doc = { update_date: Date.now() }
		if (name !== undefined) doc.name = String(name).trim()
		if (enabled !== undefined) doc.enabled = !!enabled
		await printerCol().doc(id).update(doc)
		// 设默认机（唯一）
		if (isDefault) await markDefault(id)
		return ok({ id })
	},

	/* ── 删除打印机（换机后清理旧机）；删默认机时自动把最近启用的一台提为默认 ── */
	async remove(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		if (!isStaff(actor.roles)) return fail('无打印设置权限')
		const { id } = params || {}
		if (!id) return fail('缺少打印机id')
		const res = await printerCol().doc(id).get()
		const doc = res.data && res.data[0] ? res.data[0] : null
		if (!doc) return fail('打印机不存在')
		await printerCol().doc(id).remove()
		if (doc.is_default) {
			// 删的是默认机：提一台最近启用的机当默认
			const next = await pickPrinter({})
			if (next) await markDefault(next._id)
		}
		return ok({ id })
	},

	/* ── 打印机列表（仅仓管级；key 不随列表返回，避免泄露） ── */
	async list() {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		if (!isStaff(actor.roles)) return fail('无查看权限')
		const res = await printerCol().orderBy('enabled', 'desc').orderBy('create_date', 'desc').limit(20).get()
		const list = (res.data || []).map((p) => ({
			id: p._id,
			name: p.name || '',
			brand: p.brand || 'xprinter',
			model: p.model || '',
			sn: p.sn || '',
			enabled: !!p.enabled,
			is_default: !!p.is_default,
			remark: p.remark || '',
		}))
		return ok(list)
	},

	/* ── 云推送出库/打样单 ──
	 * params: { id?, no?, times=1, sn? }
	 * 内容渲染完全基于云端 order/order_item（数据与 outbound-manage.get 同源），
	 * 前端只传单号与份数，禁止传排版内容，保证单据一致性 */
	async print(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { id, no, sn } = params || {}
		if (!id && !no) return fail('缺少出库单id或单号')
		const times = Math.max(1, Math.min(Number(params.times) || 1, 5))
		const order = await findOrder(id, no)
		if (!order) return fail('出库单不存在')
		// 营业员仅可打印本人创建的单（与出库单查看口径一致）
		if (isSalesRole(actor.roles) && String(order.created_by || '') !== String(actor.uid)) {
			return fail('无权打印该订单')
		}
		// 打样单状态归一（与详情页展示一致）
		if (order.source === 'sample' && ['配货中', '待发货', '待剪样', '已发货'].includes(order.status)) {
			order.status = '已完成'
			try {
				await orderCol().doc(order._id).update({ status: '已完成', update_date: Date.now() })
			} catch (e) {
				// 迁移失败不影响打印
			}
		}
		const rows = await loadItems(order._id)
		const view = buildPrintView(order, rows)

		/* 目标打印机（云打印只投小票；历史标签机不参与） */
		const printer = await pickPrinter({ sn })
		if (!printer || !printer.sn) return fail('未绑定可用云打印机，请先到「打印设置」绑定')
		const brand = printer.brand || 'xprinter'
		// 芯烨票据机需要机身 key
		if (!printer.key) return fail('打印机 key 缺失，请重新绑定')

		const taskBase = {
			order_id: order._id,
			order_no: view.no,
			doc_type: order.source === 'sample' ? 'sample' : 'out',
			brand,
			mode: 'ticket',
			printer_sn: printer.sn,
			printer_name: printer.name || printer.sn,
			times,
			operator_id: actor.uid,
			operator_name: actorName(actor.user),
			create_date: Date.now(),
		}

		/* ── 渲染 + 推送：xprinter 芯烨云票据机，整单 80mm 票据（票面不含单价金额） ── */
		// 打印版面不展示单价与金额：票面固定不带价格行（价格仅出现在「客户账单」转发图）
		// 版面统一按 80mm 纸（每行 48 个半角），行宽/列宽/分隔线由它派生
		const content = xpyun.buildTicketContent(view, { withPrice: false })
		let pushedId = ''
		/* 云平台原始响应：落库到 print_task.resp。排查「提示已推送却不出纸」时以此为准 */
		let rawResp = ''
		try {
			const pushRes = await xpyun.pushTicket(xpyunConfig(), { sn: printer.sn, content, times })
			pushedId = pushRes.xpyunOrderId
		} catch (e) {
			// 推送失败也落库，便于排查与补打；云平台抛错时带 body（原始返回体），优先留档
			await taskCol()
				.add({
					...taskBase,
					content,
					status: 'fail',
					err: String((e && e.message) || e),
					resp: e && e.body ? JSON.stringify(e.body) : rawResp,
					update_date: Date.now(),
				})
				.catch(() => {})
			return fail(`云打印失败：${e.message || e}`, -2)
		}
		const taskRes = await taskCol()
			.add({
				...taskBase,
				content,
				status: 'pushed',
				remote_order_id: pushedId,
				// 兼容历史字段：芯烨任务号沿用 xpyun_order_id
				xpyun_order_id: pushedId,
				resp: rawResp,
				update_date: Date.now(),
			})
			.catch(() => null)
		return ok({
			taskId: taskRes ? taskRes.id : '',
			remoteOrderId: pushedId,
			xpyunOrderId: pushedId,
			brand,
			mode: 'ticket',
			printerSn: printer.sn,
			printerName: printer.name || printer.sn,
		})
	},

	/* ── 某单打印记录（与查看该单同权限；含失败/补打历史） ── */
	async tasks(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { orderId, orderNo } = params || {}
		if (!orderId && !orderNo) return fail('缺少出库单id或单号')
		const order = await findOrder(orderId, orderNo)
		if (!order) return fail('出库单不存在')
		if (isSalesRole(actor.roles) && String(order.created_by || '') !== String(actor.uid)) {
			return fail('无权查看该订单')
		}
		const where = orderNo ? { order_no: order.no } : { order_id: order._id }
		const res = await taskCol()
			.where(where)
			.orderBy('create_date', 'desc')
			.limit(20)
			.get()
		const list = (res.data || []).map((t) => ({
			id: t._id,
			orderNo: t.order_no || '',
			docType: t.doc_type || 'out',
			brand: t.brand || 'xprinter',
			mode: t.mode || 'ticket',
			printerName: t.printer_name || t.printer_sn || '',
			times: t.times || 1,
			status: t.status || 'pushed',
			remoteOrderId: t.remote_order_id || t.xpyun_order_id || '',
			xpyunOrderId: t.xpyun_order_id || '',
			err: t.err || '',
			operatorName: t.operator_name || '',
			createDate: t.create_date || 0,
		}))
		return ok(list)
	},

	/* ── 回查任务是否已打印（按品牌回查并更新任务状态） ── */
	async query(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { taskId } = params || {}
		if (!taskId) return fail('缺少任务id')
		const tRes = await taskCol().doc(taskId).get()
		const task = tRes.data && tRes.data[0] ? tRes.data[0] : null
		if (!task) return fail('打印任务不存在')
		if (isSalesRole(actor.roles) && String(task.operator_id || '') !== String(actor.uid)) {
			return fail('无权查看该任务')
		}
		const remoteId = task.remote_order_id || task.xpyun_order_id || ''
		if (!remoteId) return fail('该任务无云端任务号，无法回查')
		const brand = task.brand || 'xprinter'
		let state = {}
		let status = task.status || 'pushed'
		try {
			state = await xpyun.queryOrderState(xpyunConfig(), remoteId)
			// 芯烨 status：0 未打印 / 1 已打印 / 2 打印失败
			status = state.status === 1 ? 'success' : state.status === 2 ? 'fail' : status
		} catch (e) {
			return fail(`回查失败：${e.message || e}`)
		}
		if (status !== task.status) {
			await taskCol().doc(task._id).update({ status, update_date: Date.now() }).catch(() => {})
		}
		return ok({ taskId, brand, remoteOrderId: remoteId, remoteStatus: state.status, status, state })
	},
}
