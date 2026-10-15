'use strict'

/* ════════════════════════════════════════════════════════════════════
 * 字典管理云对象（dict-manage）
 *   合并自 customer-manage / location-manage / printer-manage 三个云对象。
 *   目的：消灭 3 个低消位（0.72 元/天），节省计费。
 *   合并原则：
 *     - 业务代码、权限模型、返回结构与原 3 个云对象完全等价（前端调用方无感）
 *     - 顶层变量与 helper 函数加前缀防冲突（customerXxx / locationXxx / printerXxx）
 *     - 高频业务（fabric / inbound / outbound / inventory）仍独立，未合并
 *   方法清单：
 *     customerList / customerListOptions / customerListByIds / customerGet /
 *     customerAdd / customerUpdate / customerRemove
 *     locationList / locationListOptions / locationAddZone / locationRenameZone /
 *     locationRemoveZone / locationAddLoc / locationRemoveLoc
 *     printerBind / printerUpdate / printerRemove / printerList /
 *     printerPrint / printerTasks / printerQuery
 * ════════════════════════════════════════════════════════════════════ */

/* ── 统一返回结构 / 鉴权：抽到 common/auth-common 公共模块 ── */
const { ok, fail, getActor, checkAdmin, checkEditor, checkStaff } = require('auth-common')

const xpyun = require('xpyun-print')

/* ════════════════════════════════════════════════════════════════════
 * 客户管理（合并自 customer-manage）
 * ════════════════════════════════════════════════════════════════════ */

let _customerCol = null
function customerCol() {
	if (!_customerCol) _customerCol = uniCloud.database().collection('customer')
	return _customerCol
}

function customerToView(row) {
	return {
		id: row._id,
		name: row.name || '',
		company: row.company || '',
		phone: row.phone || '',
		region: row.region || '',
		address: row.address || '',
		remark: row.remark || '',
		orderCount: row.order_count || 0,
		lastOrder: row.last_order || '',
	}
}

/* 权限模型（与原 customer-manage 同构）：
 *   admin        ：增/改/删
 *   salesperson  ：可新增/编辑客户（含历史 sales 归一），删除除外
 *   warehouse    ：只读
 *   任意登录用户  ：可读取
 * 鉴权函数由 auth-common 提供：getActor / checkAdmin / checkEditor
 * 实际口径与 customer-manage 完全一致，此处不再赘述。 */

const customerMethods = {
	/* ── 客户列表（登录角色可读，关键词服务端搜索 + 分页） ── */
	async customerList(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { keyword = '', page = 1, pageSize = 50 } = params || {}
		const p = Math.max(1, Number(page) || 1)
		const size = Math.min(Math.max(Number(pageSize) || 50, 1), 100)
		let where = {}
		const q = String(keyword).trim()
		if (q) {
			const reg = new RegExp(q)
			where = uniCloud.database().command.or([{ name: reg }, { company: reg }, { phone: reg }, { region: reg }])
		}
		const res = await customerCol()
			.where(where)
			.orderBy('create_date', 'desc')
			.field({ name: true, company: true, phone: true, region: true, address: true, remark: true, order_count: true, last_order: true })
			.skip((p - 1) * size)
			.limit(size)
			.get()
		return ok({ list: res.data.map((r) => customerToView(r)), hasMore: res.data.length === size })
	},

	/* ── 客户选项（选择器用：轻量、免登录校验） ── */
	async customerListOptions(params) {
		const { keyword = '', offset = 0, limit = 50 } = params || {}
		const size = Math.min(Math.max(Number(limit) || 50, 1), 100)
		let where = {}
		const q = String(keyword).trim()
		if (q) {
			const reg = new RegExp(q)
			const cmd = uniCloud.database().command
			where = cmd.or([{ name: reg }, { company: reg }, { phone: reg }])
		}
		const res = await customerCol()
			.where(where)
			.orderBy('create_date', 'desc')
			.field({ name: true, company: true, phone: true })
			.skip(Number(offset) || 0)
			.limit(size)
			.get()
		return ok({ list: res.data, hasMore: res.data.length === size })
	},

	/* ── 按 id 批量查询客户（列表实时同步用：轻量、免登录校验） ── */
	async customerListByIds(params) {
		const { ids = [] } = params || {}
		if (!Array.isArray(ids) || !ids.length) return ok({ list: [] })
		const cmd = uniCloud.database().command
		// limit(1000)：ids 超 100 时默认 get 上限会静默截断，列表客户名同步缺项
		const res = await customerCol().where({ _id: cmd.in(ids) }).field({ name: true, company: true }).limit(1000).get()
		return ok({ list: res.data })
	},

	/* ── 客户详情 ── */
	async customerGet(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { id } = params || {}
		if (!id) return fail('缺少客户id')
		const res = await customerCol().doc(id).get()
		if (!res.data.length) return fail('客户不存在')
		return ok(customerToView(res.data[0]))
	},

	/* ── 新增客户 ── */
	async customerAdd(params) {
		const denied = await checkEditor(this)
		if (denied) return denied
		const { name, phone, company = '', region = '', address = '', remark = '' } = params || {}
		if (!name || !name.trim()) return fail('请填写客户姓名')
		// 联系电话选填（快速新建客户场景可暂不填）：留空存空串，后续可在客户详情补录
		const now = Date.now()
		const addRes = await customerCol().add({
			name: name.trim(),
			phone: (phone || '').trim(),
			company: company.trim(),
			region: region.trim(),
			address: address.trim(),
			remark: remark.trim(),
			order_count: 0,
			last_order: '',
			create_date: now,
			update_date: now,
		})
		return ok({ id: addRes.id })
	},

	/* ── 更新客户基本信息 ── */
	async customerUpdate(params) {
		const denied = await checkEditor(this)
		if (denied) return denied
		const { id } = params || {}
		if (!id) return fail('缺少客户id')
		const data = { update_date: Date.now() }
		const args = params || {}
		for (const k of ['name', 'company', 'phone', 'region', 'address', 'remark']) {
			if (args[k] !== undefined) data[k] = (args[k] || '').trim()
		}
		const res = await customerCol().doc(id).update(data)
		if (!res.updated) return fail('客户不存在或未变更')
		return ok({ id })
	},

	/* ── 删除客户（存在历史出库单引用时禁止删除） ── */
	async customerRemove(params) {
		const denied = await checkAdmin(this)
		if (denied) return denied
		const { id } = params || {}
		if (!id) return fail('缺少客户id')
		// 防悬空引用：该客户若仍有出库单记录，禁止删除（主从表重构后查 order 主表）
		const used = await uniCloud
			.database()
			.collection('order')
			.where({ customer_id: id })
			.count()
		if (used.total > 0) return fail(`该客户存在 ${used.total} 笔出库单，无法删除`)
		await customerCol().doc(id).remove()
		return ok({ id })
	},
}

/* ════════════════════════════════════════════════════════════════════
 * 库位管理（合并自 location-manage）
 * ════════════════════════════════════════════════════════════════════ */

let _locationZoneCol = null
let _locationLocCol = null
let _locationRollCol = null
function locationZoneCol() {
	if (!_locationZoneCol) _locationZoneCol = uniCloud.database().collection('location_zone')
	return _locationZoneCol
}
function locationLocCol() {
	if (!_locationLocCol) _locationLocCol = uniCloud.database().collection('location')
	return _locationLocCol
}
function locationRollCol() {
	if (!_locationRollCol) _locationRollCol = uniCloud.database().collection('stock_roll')
	return _locationRollCol
}

/* 分页拉取集合下全部匹配记录：云函数单次 get 默认只返回 100 条，库位数据量可超百
 * （如导入整区 100 条后总量破百），不分页会静默截断 —— 典型症状：库位设置页只显示一部分库位，
 * 而盘点页因分页拉全故显示完整。固定每页 200 循环拼全；
 * orders 形如 [['_id','asc']]，跨页排序稳定防漏重（_id 递增，与原有自然顺序基本一致）。
 * 注：与 stocktake-manage 内同名实现保持同源，未抽公共模块以免新增模块带来的部署联动。 */
async function locationFetchAll(col, where, fields = [], orders = []) {
	const out = []
	const pageSize = 200
	for (let offset = 0; ; offset += pageSize) {
		let q = col.where(where)
		orders.forEach(([key, dir]) => {
			q = q.orderBy(key, dir)
		})
		q = q.skip(offset).limit(pageSize)
		if (fields.length) {
			q = q.field(fields.reduce((o, k) => ((o[k] = true), o), {}))
		}
		const res = await q.get()
		out.push(...res.data)
		if (res.data.length < pageSize) break
	}
	return out
}

/* 区内库位按库位号自然升序（行-列数字从小到大）。
 * 不能直接按 code 字符串排：字典序会把 C1-10 排到 C1-2 前面（'10' < '2'），格子顺序就乱了。
 * 故逐段切分（数字段 / 非数字段）：数字段比数值、文本段比字典序；
 * 数字值相等时（如 1-01 与 1-1）继续比后续段，全等则按原字符串兜底，保证顺序稳定可预期。 */
function locationSortLocs(locs) {
	const seq = (code) => String(code || '').match(/\d+|\D+/g) || []
	return locs.sort((a, b) => {
		const sa = seq(a.code)
		const sb = seq(b.code)
		const n = Math.min(sa.length, sb.length)
		for (let i = 0; i < n; i++) {
			const numericA = /^\d/.test(sa[i])
			const numericB = /^\d/.test(sb[i])
			if (numericA && numericB) {
				const diff = Number(sa[i]) - Number(sb[i])
				if (diff !== 0) return diff
			} else if (sa[i] !== sb[i]) {
				return sa[i] < sb[i] ? -1 : 1
			}
		}
		if (sa.length !== sb.length) return sa.length - sb.length
		return a.code < b.code ? -1 : a.code > b.code ? 1 : 0
	})
}

/* 权限模型（与原 location-manage 同构）：
 *   admin / warehouse：库位布局维护，读与增删改全部开放
 *   salesperson 等   ：库位设置无权限
 *   出入库等业务选库位走 locationListOptions（免鉴权、仅返回启用库位），不受本限制
 * 库位管理校验：管理员 / 仓管（公共模块 checkStaff + 本对象提示语） */
const locationCheckManager = (ctx) => checkStaff(ctx, '仅管理员和仓管可管理库位设置')

const locationMethods = {
	/* ── 库位树（区 + 区内库位，库位设置页） ── */
	async locationList() {
		const denied = await locationCheckManager(this)
		if (denied) return denied
		/* 库区分页拉全（区数量少，orderBy 单页即可）；库位必须分页：单次 get 上限 100 条，
		 * 超出即静默截断，导致设置页只显示一部分库位 */
		const zoneRes = await locationZoneCol().orderBy('sort', 'asc').get()
		const locs = await locationFetchAll(locationLocCol(), {}, ['zone_id', 'code', 'status'], [['_id', 'asc']])
		const byZone = {}
		locs.forEach((l) => {
			const k = l.zone_id
			if (!byZone[k]) byZone[k] = []
			byZone[k].push({ id: l._id, code: l.code || '', status: l.status !== undefined ? l.status : 1 })
		})
		const list = zoneRes.data.map((z) => ({
			id: z._id,
			name: z.name || '',
			sort: z.sort || 0,
			/* 库位默认按库位号数字升序（1-1、1-2 … 1-10），不依赖插入顺序 */
			locations: locationSortLocs(byZone[z._id] || []),
		}))
		return ok({ list })
	},

	/* ── 库位选项（选择器用：轻量、免登录校验，仅返回启用库位） ── */
	async locationListOptions() {
		const zoneRes = await locationZoneCol().orderBy('sort', 'asc').get()
		/* 该接口供出入库等选择器使用：同样必须分页拉全，否则总量超 100 条后库位选择器会缺项 */
		const locs = await locationFetchAll(
			locationLocCol(),
			{ status: uniCloud.database().command.neq(0) },
			['zone_id', 'code'],
			[['_id', 'asc']]
		)
		const byZone = {}
		locs.forEach((l) => {
			const k = l.zone_id
			if (!byZone[k]) byZone[k] = []
			byZone[k].push({ id: l._id, code: l.code || '' })
		})
		return ok({
			list: zoneRes.data.map((z) => ({
				id: z._id,
				name: z.name || '',
				locations: locationSortLocs(byZone[z._id] || []),
			})),
		})
	},

	/* ── 新增库区 ── */
	async locationAddZone(params) {
		const denied = await locationCheckManager(this)
		if (denied) return denied
		const name = String((params || {}).name || '').trim()
		if (!name) return fail('请输入区名')
		const exists = await locationZoneCol().where({ name }).count()
		if (exists.total > 0) return fail('该区已存在')
		const now = Date.now()
		const addRes = await locationZoneCol().add({
			name,
			sort: 0,
			remark: '',
			create_date: now,
			update_date: now,
		})
		return ok({ id: addRes.id })
	},

	/* ── 重命名库区 ── */
	async locationRenameZone(params) {
		const denied = await locationCheckManager(this)
		if (denied) return denied
		const { id } = params || {}
		if (!id) return fail('缺少区id')
		const name = String((params || {}).name || '').trim()
		if (!name) return fail('区名不能为空')
		const cmd = uniCloud.database().command
		const exists = await locationZoneCol().where({ name, _id: cmd.neq(id) }).count()
		if (exists.total > 0) return fail('该区已存在')
		const res = await locationZoneCol().doc(id).update({ name, update_date: Date.now() })
		if (!res.updated) return fail('区不存在或未变更')
		return ok({ id })
	},

	/* ── 删除库区（连同区内库位，区下存在在库布卷时禁止删除） ── */
	async locationRemoveZone(params) {
		const denied = await locationCheckManager(this)
		if (denied) return denied
		const { id } = params || {}
		if (!id) return fail('缺少区id')
		/* 分页拉全：超 100 条时截断会漏掉部分库位，导致「区下仍有在库布卷」漏检而误删整区 */
		const locs = await locationFetchAll(locationLocCol(), { zone_id: id }, ['code'], [['_id', 'asc']])
		if (locs.length) {
			const codes = [...new Set(locs.map((l) => (l.code || '').trim()).filter(Boolean))]
			if (codes.length) {
				const rollRes = await locationRollCol()
					.where({ location: uniCloud.database().command.in(codes), status: '在库' })
					.count()
				if (rollRes.total > 0) return fail(`该区下还有 ${rollRes.total} 卷在库，无法删除`)
			}
			await locationLocCol().where({ zone_id: id }).remove()
		}
		await locationZoneCol().doc(id).remove()
		return ok({ id })
	},

	/* ── 新增库位 ── */
	async locationAddLoc(params) {
		const denied = await locationCheckManager(this)
		if (denied) return denied
		const { zoneId } = params || {}
		let code = String((params || {}).code || '').trim().toUpperCase()
		if (!zoneId) return fail('缺少区id')
		if (!code) return fail('请输入库位编码')
		const zone = await locationZoneCol().doc(zoneId).get()
		if (!zone.data.length) return fail('库区不存在')
		/* 库位码规范：完整码 = 区字母+位置（紧凑式，如 A5-10），区字母与位置间不带连字符；
		 * 兼容输入：5-10（短码自动补区字母）、A5-10（紧凑）、A-5-10（旧三段）统一归一为 A5-10 */
		const pm = String(zone.data[0].name || '').match(/^[A-Za-z]/)
		const prefix = pm ? pm[0].toUpperCase() : ''
		const lead = code.match(/^([A-Za-z])(-?)(.*)$/)
		if (lead) {
			// 输入自带区字母：须与当前库区一致，避免跨区误录；旧三段 A-5-10 去掉字母后连字符
			if (prefix && lead[1] !== prefix) return fail(`库位区号「${lead[1]}」与当前库区「${prefix}」不符`)
			code = (prefix || lead[1]) + lead[3].replace(/^-/, '')
		} else if (prefix) {
			// 仅输入短码（如 5-10）：自动补当前区字母
			code = prefix + code
		}
		/* 区内去重：按归一化紧凑码比对，防止同位置的新（A5-10）/旧（A-5-10）编码并存 */
		const normLoc = (c) => String(c || '').trim().toUpperCase().replace(/^([A-Za-z])-/, '$1')
		/* 分页拉全：单区库位超 100 条时截断会导致查重漏判，放进重复编码 */
		const locs = await locationFetchAll(locationLocCol(), { zone_id: zoneId }, ['code'], [['_id', 'asc']])
		const dup = locs.find((l) => normLoc(l.code) === normLoc(code))
		if (dup) return fail(`该区下已存在此库位编码「${dup.code}」，请勿重复添加`)
		const now = Date.now()
		const addRes = await locationLocCol().add({
			zone_id: zoneId,
			code,
			status: 1,
			remark: '',
			create_date: now,
			update_date: now,
		})
		return ok({ id: addRes.id })
	},

	/* ── 删除库位（库位下存在在库布卷时禁止删除） ── */
	async locationRemoveLoc(params) {
		const denied = await locationCheckManager(this)
		if (denied) return denied
		const { id } = params || {}
		if (!id) return fail('缺少库位id')
		const locDoc = await locationLocCol().doc(id).get()
		if (!locDoc.data.length) return fail('库位不存在')
		const code = (locDoc.data[0].code || '').trim()
		if (code) {
			const rollRes = await locationRollCol().where({ location: code, status: '在库' }).count()
			if (rollRes.total > 0) return fail(`该库位下还有 ${rollRes.total} 卷在库，无法删除`)
		}
		await locationLocCol().doc(id).remove()
		return ok({ id })
	},
}

/* ════════════════════════════════════════════════════════════════════
 * 打印机与云打印任务管理（合并自 printer-manage）
 *   依赖：printer（打印机配置集合）、print_task（打印任务集合）、
 *         order / order_item（只读出库单，打印内容以云端订单数据为准）
 *   推送：xprinter 芯烨云（xpyun-print）票据 = printerPrint 接口 + 80mm 小票版式
 * ════════════════════════════════════════════════════════════════════ */

let _printerCol = null
let _printerTaskCol = null
let _printerOrderCol = null
let _printerItemCol = null
function printerCol() {
	if (!_printerCol) _printerCol = uniCloud.database().collection('printer')
	return _printerCol
}
function printerTaskCol() {
	if (!_printerTaskCol) _printerTaskCol = uniCloud.database().collection('print_task')
	return _printerTaskCol
}
function printerOrderCol() {
	if (!_printerOrderCol) _printerOrderCol = uniCloud.database().collection('order')
	return _printerOrderCol
}
function printerItemCol() {
	if (!_printerItemCol) _printerItemCol = uniCloud.database().collection('order_item')
	return _printerItemCol
}

/* 单行米数：优先 total_meters，兼容历史行 */
function printerRowMeters(row) {
	if (row.total_meters) return row.total_meters
	return parseFloat((row.rolls || []).reduce((s, v) => s + v, 0).toFixed(1))
}

/* ── 明细行 → 打印视图元素（与 outbound-manage.toItem 同口径） ── */
function printerToItem(row) {
	return {
		id: row._id,
		name: row.name || '',
		color: row.color || '',
		location: row.location || '',
		locations: Array.isArray(row.locations) ? row.locations : [],
		rolls: row.rolls || [],
		count: row.count || 0,
		total_meters: printerRowMeters(row),
		demandMeters: row.demand_meters || 0,
		demandCount: row.demand_count || 0,
		sampleCuts: Array.isArray(row.sample_cuts) ? row.sample_cuts : [],
		price: row.price === undefined || row.price === null ? undefined : Number(row.price),
		unit: row.unit === 'count' ? 'count' : row.unit === 'meters' ? 'meters' : undefined,
		amount: row.amount === undefined || row.amount === null ? undefined : Math.round(Number(row.amount) * 100) / 100,
	}
}

/* ── 主表 + 明细 → 打印聚合视图 ── */
function printerBuildView(order, rows) {
	const items = rows.map(printerToItem)
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
async function printerFindOrder(id, no) {
	let res = null
	if (id) {
		res = await printerOrderCol().doc(id).get()
	} else if (no) {
		res = await printerOrderCol().where({ no }).limit(1).get()
	}
	return res && res.data && res.data[0] ? res.data[0] : null
}

/* 拉取某单全部明细（按创建时间升序）
 * limit(1000)：云函数端 get 默认上限 100 条，大单明细超 100 会导致票面打印内容缺失 */
async function printerLoadItems(orderId) {
	if (!orderId) return []
	const res = await printerItemCol().where({ order_id: orderId }).orderBy('create_date', 'asc').limit(1000).get()
	return res.data
}

/* ── 默认机唯一化：把指定机设为默认，其余取消；换机后云打印自动指向新机。
 * 历史 kind='label' 标签机不参与（云标签通道已下线，重绑后归一为票据机） ── */
async function printerMarkDefault(id) {
	const cmd = uniCloud.database().command
	await printerCol().where({ kind: cmd.neq('label'), _id: cmd.neq(id) }).update({ is_default: false, update_date: Date.now() })
	await printerCol().doc(id).update({ is_default: true, update_date: Date.now() })
}

/* 读取芯烨云开发者配置（uni-config-center 插件 uni-xpyun） */
function printerXpyunConfig() {
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
async function printerPickPrinter({ sn }) {
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

/* 从 auth-common 复用角色判定（isStaff / isSalesRole / actorName） */
const { isStaff, isSalesRole, actorName } = require('auth-common')

const printerMethods = {
	/* ── 绑定/更换打印机（仅仓管级）──
	 * 芯烨（xprinter）：填机身 SN/key → 自动注册到芯烨开发者账号 → 落库 → 切默认机。
	 *   注册失败不阻断落库（可能已在 admin.xpyun.net 手动添加过），返回值带 warning 供前端提示。 */
	async printerBind(params) {
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
			await xpyun.bindPrinter(printerXpyunConfig(), [{ sn: snText, name: nameText }])
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
		if (isDefault || defaultCount.total === 0) await printerMarkDefault(id)

		return ok({ id, sn: snText, brand: brandText, registered: !warning, warning })
	},

	/* ── 局部更新（不改 sn/key）：名称/启用/设为默认 ── */
	async printerUpdate(params) {
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
		if (isDefault) await printerMarkDefault(id)
		return ok({ id })
	},

	/* ── 删除打印机（换机后清理旧机）；删默认机时自动把最近启用的一台提为默认 ── */
	async printerRemove(params) {
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
			const next = await printerPickPrinter({})
			if (next) await printerMarkDefault(next._id)
		}
		return ok({ id })
	},

	/* ── 打印机列表（仅仓管级；key 不随列表返回，避免泄露） ── */
	async printerList() {
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
	async printerPrint(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { id, no, sn } = params || {}
		if (!id && !no) return fail('缺少出库单id或单号')
		const times = Math.max(1, Math.min(Number(params.times) || 1, 5))
		const order = await printerFindOrder(id, no)
		if (!order) return fail('出库单不存在')
		// 营业员仅可打印本人创建的单（与出库单查看口径一致）
		if (isSalesRole(actor.roles) && String(order.created_by || '') !== String(actor.uid)) {
			return fail('无权打印该订单')
		}
		// 打样单状态归一（与详情页展示一致）
		if (order.source === 'sample' && ['配货中', '待发货', '待剪样', '已发货'].includes(order.status)) {
			order.status = '已完成'
			try {
				await printerOrderCol().doc(order._id).update({ status: '已完成', update_date: Date.now() })
			} catch (e) {
				// 迁移失败不影响打印
			}
		}
		const rows = await printerLoadItems(order._id)
		const view = printerBuildView(order, rows)

		/* 目标打印机（云打印只投小票；历史标签机不参与） */
		const printer = await printerPickPrinter({ sn })
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
			const pushRes = await xpyun.pushTicket(printerXpyunConfig(), { sn: printer.sn, content, times })
			pushedId = pushRes.xpyunOrderId
		} catch (e) {
			// 推送失败也落库，便于排查与补打；云平台抛错时带 body（原始返回体），优先留档
			await printerTaskCol()
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
		const taskRes = await printerTaskCol()
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
	async printerTasks(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { orderId, orderNo } = params || {}
		if (!orderId && !orderNo) return fail('缺少出库单id或单号')
		const order = await printerFindOrder(orderId, orderNo)
		if (!order) return fail('出库单不存在')
		if (isSalesRole(actor.roles) && String(order.created_by || '') !== String(actor.uid)) {
			return fail('无权查看该订单')
		}
		const where = orderNo ? { order_no: order.no } : { order_id: order._id }
		const res = await printerTaskCol()
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
	async printerQuery(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { taskId } = params || {}
		if (!taskId) return fail('缺少任务id')
		const tRes = await printerTaskCol().doc(taskId).get()
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
			state = await xpyun.queryOrderState(printerXpyunConfig(), remoteId)
			// 芯烨 status：0 未打印 / 1 已打印 / 2 打印失败
			status = state.status === 1 ? 'success' : state.status === 2 ? 'fail' : status
		} catch (e) {
			return fail(`回查失败：${e.message || e}`)
		}
		if (status !== task.status) {
			await printerTaskCol().doc(task._id).update({ status, update_date: Date.now() }).catch(() => {})
		}
		return ok({ taskId, brand, remoteOrderId: remoteId, remoteStatus: state.status, status, state })
	},
}

/* ════════════════════════════════════════════════════════════════════
 * 导出（合并 3 块方法）
 * ════════════════════════════════════════════════════════════════════ */

module.exports = Object.assign({}, customerMethods, locationMethods, printerMethods)