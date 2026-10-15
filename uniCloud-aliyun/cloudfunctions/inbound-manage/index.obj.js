'use strict'

/* 惰性获取集合引用 */
let _col = null
function col() {
	if (!_col) _col = uniCloud.database().collection('inbound_order')
	return _col
}

/* ── 统一返回结构 / 鉴权：抽到 common/auth-common 公共模块 ── */
const { ok, fail, checkLogin, checkStaff } = require('auth-common')

/* 数据库行 → 前端视图模型（对齐 StockOrder） */
function toView(row) {
	return {
		id: row._id,
		type: '入库',
		batchNo: row.no,
		name: row.name || '',
		color: row.color || '',
		supplier: row.supplier || '',
		customerId: row.customer_id || '',
		count: row.count || 0,
		rolls: row.rolls || [],
		date: row.date || '',
		time: row.time || '',
		location: row.location || '',
		status: row.status || '待入库',
		/** 入库类型：arrival=到货 / return=退货（历史数据缺失兜底到货） */
		kind: row.kind || 'arrival',
	}
}


/* 生成入库单号：RK + yyyyMMdd + 3 位序号
 * 云函数运行环境默认 UTC+0，这里按东八区（UTC+8）生成日期，避免凌晨创建的
 * 单号/日期与前端本地日期错位，导致列表按「今天」筛选查不到 */
async function nextNo() {
	const now = new Date(Date.now() + 8 * 3600 * 1000)
	const p = (x) => String(x).padStart(2, '0')
	const prefix = `RK${String(now.getUTCFullYear()).slice(-2)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`
	const res = await col().where({ no: new RegExp(`^${prefix}`) }).orderBy('no', 'desc').limit(1).get()
	const last = res.data[0] && res.data[0].no || ''
	const seq = last ? parseInt(last.slice(-2), 10) + 1 : 1
	return `${prefix}${String(seq).padStart(2, '0')}`
}

/* 事务内单条读取：统一兼容返回对象/数组，文档不存在返回 null */
async function tDocGet(t, coll, id) {
	const res = await t.collection(coll).doc(id).get()
	const d = Array.isArray(res.data) ? res.data[0] : res.data
	return d && d._id ? d : null
}

/* 确认入库的字典准备（只读）：查出该品名/颜色的字典 id，缺失时分配好编号，
 * 建档与入账写入统一收敛在事务（writeStockInTx）内执行，保证原子 */
async function prepareStockDicts(name, color) {
	const db = uniCloud.database()
	let fab = null
	const fabricRes = await db.collection('fabric').where({ name }).limit(1).get()
	if (fabricRes.data.length) {
		fab = { _id: fabricRes.data[0]._id, color_ids: fabricRes.data[0].color_ids || [] }
	} else {
		const maxRes = await db.collection('fabric').orderBy('sort', 'desc').limit(1).get()
		const sort = ((maxRes.data[0] && maxRes.data[0].sort) || 0) + 1
		fab = { _id: '', color_ids: [], sort }
	}
	let colorDoc = null
	const colorRes = await db.collection('fabric_color').where({ name: color }).limit(1).get()
	if (colorRes.data.length) {
		colorDoc = { _id: colorRes.data[0]._id }
	} else {
		const maxRes = await db.collection('fabric_color').orderBy('color_code', 'desc').limit(1).get()
		const last = ((maxRes.data[0] && parseInt(maxRes.data[0].color_code, 10)) || 0) + 1
		colorDoc = { _id: '', color_code: last }
	}
	return { fab, colorDoc }
}

/* ── 事务内写库存：按入库单 id 入账 stock_roll（先删该单旧记录再重建，幂等） ──
 * order: { _id, no, name, color, rolls }；location 为本次确认填写的库位
 * 同一批登记的多款/多色共享一个单号（no）但各自是独立入库单，逐张确认；
 * 因此幂等定位必须用入库单 _id，不能用单号，否则后确认的单会误删同批其他颜色/品名的卷
 * 品名/颜色不存在时事务内自动建档到 fabric / fabric_color；
 * 删除旧卷逐卷复核（确属本单且仍在库）后删，防并发下误删已被其他单据/盘点改动的卷 */
async function writeStockInTx(t, order, location, existRolls, prep, now) {
	// 1. 删除该入库单旧在库细码（幂等重入时清理历史卷，避免同一单据重复入账）
	for (const r of existRolls || []) {
		const cur = await tDocGet(t, 'stock_roll', r._id)
		if (cur && cur.inbound_id === order._id && cur.status === '在库') {
			await t.collection('stock_roll').doc(r._id).remove()
		}
	}
	// 2. 找到或创建品名（fabric）
	let fab = prep.fab
	if (!fab._id) {
		const addRes = await t.collection('fabric').add({
			name: order.name,
			sort: fab.sort,
			create_date: now,
			update_date: now,
		})
		fab._id = addRes.id
	}
	// 3. 找到或创建颜色（fabric_color 全局字典，同名颜色只有一行）
	let colorDoc = prep.colorDoc
	if (!colorDoc._id) {
		const addRes = await t.collection('fabric_color').add({
			name: order.color,
			color_code: String(colorDoc.color_code).padStart(2, '0'),
			create_date: now,
			update_date: now,
		})
		colorDoc._id = addRes.id
	}
	// 3.1 关联到品名（品名已存在且未关联该颜色时追加 color_ids）
	const ids = fab.color_ids || []
	if (!ids.includes(colorDoc._id)) {
		await t.collection('fabric').doc(fab._id).update({ color_ids: [...ids, colorDoc._id], update_date: now })
		fab.color_ids = [...ids, colorDoc._id]
	}
	// 4. 按细码逐卷入账
	const lengths = (order.rolls || [])
		.map((v) => Number(v))
		.filter((v) => v > 0)
	for (const length of lengths) {
		await t.collection('stock_roll').add({
			fabric_id: fab._id,
			color_id: colorDoc._id,
			length,
			location: (location || '').trim(),
			batch_no: order.no,
			inbound_no: order.no,
			inbound_id: order._id,
			status: '在库',
			create_date: now,
			update_date: now,
		})
	}
	return lengths.length
}

module.exports = {
	/* ── 接口：入库单列表（空库自动初始化种子数据）
	 * 参数：keyword 搜索品名/颜色/单号；
	 *      date 精确日期筛选（YYYY-MM-DD）；
	 *      startDate/endDate 日期范围筛选（YYYY-MM-DD）；
	 *      kind 类型筛选（arrival=到货 / return=退货）；
	 *      status 状态筛选（待入库/已入库/all）；
	 *      page/pageSize 分页（默认 1/50）——入库单长期累积可能上千，
	 *      固定 limit 一次拉全是旧的截断做法，必须分页 + hasMore 触底加载
	 * 日期口径随状态联动（与出库列表方案一致）：终态单（已入库，含历史「已完成」）
	 * 按实际入库时间（update_date，东八区）归期，其余状态/全部按登记日期（date）过滤 ── */
	async list(params) {
		// 入库单列表全员（登录用户）可见：营业员可查看到货/退货流水，写操作仍限仓管级
		const denied = await checkLogin(this)
		if (denied) return denied
		const { keyword = '', date = '', startDate = '', endDate = '', kind = '', status = '', page = 1, pageSize = 50 } = params || {}
		const p = Math.max(1, parseInt(page, 10) || 1)
		const ps = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 50))
		const cmd = uniCloud.database().command
		let where = {}
		let hasCond = false
		if (keyword) {
			const reg = new RegExp(keyword)
			where = cmd.or([{ name: reg }, { color: reg }, { no: reg }])
			hasCond = true
		}
		if (kind && kind !== 'all') {
			// 与统计分组兜底一致：到货 = kind 为 arrival，或历史数据缺 kind 字段（默认归到货）
			const kindCond = kind === 'return' ? { kind } : cmd.or([{ kind: 'arrival' }, { kind: cmd.exists(false) }])
			where = hasCond ? cmd.and([where, kindCond]) : kindCond
			hasCond = true
		}
		let dateCond = null
		if (date || startDate || endDate) {
			/* 日期口径：终态单（已入库，含历史「已完成」）按实际入库时间 update_date
			 * （东八区当天 0 点 ≤ t < 次日 0 点），其余按登记日期 date（YYYY-MM-DD 字符串） */
			if (status === '已入库' || status === '已完成') {
				const dayStart = (d) => Date.parse(`${d}T00:00:00+08:00`)
				if (date) {
					dateCond = { update_date: cmd.gte(dayStart(date)).and(cmd.lt(dayStart(date) + 24 * 3600 * 1000)) }
				} else if (startDate && endDate) {
					dateCond = { update_date: cmd.gte(dayStart(startDate)).and(cmd.lt(dayStart(endDate) + 24 * 3600 * 1000)) }
				} else if (startDate) {
					dateCond = { update_date: cmd.gte(dayStart(startDate)) }
				} else {
					dateCond = { update_date: cmd.lt(dayStart(endDate) + 24 * 3600 * 1000) }
				}
			} else if (date) {
				dateCond = { date }
			} else {
				const cond = {}
				if (startDate && endDate) {
					cond.date = cmd.gte(startDate).and(cmd.lte(endDate))
				} else if (startDate) {
					cond.date = cmd.gte(startDate)
				} else {
					cond.date = cmd.lte(endDate)
				}
				dateCond = cond
			}
		}
		if (dateCond) {
			where = hasCond ? cmd.and([where, dateCond]) : dateCond
		}
		// 状态过滤下沉云端（与首页统计同口径）：历史两态兼容 待确认→待入库、已完成→已入库
		if (status && status !== 'all') {
			const sList = status === '待入库' ? ['待入库', '待确认'] : status === '已入库' ? ['已入库', '已完成'] : [status]
			const statusCond = { status: cmd.in(sList) }
			where = hasCond ? cmd.and([where, statusCond]) : statusCond
		}
		// 列表页不需要 rolls（细码）大字段，排除以减小传输；详情走 get 接口完整返回
		// total 返回当前筛选条件下的单数总量，供列表分页与首页统计对账
		const [res, cnt] = await Promise.all([
			col().where(where).orderBy('create_date', 'desc').field({ rolls: false }).skip((p - 1) * ps).limit(ps).get(),
			col().where(where).count(),
		])
		const total = cnt.total || 0
		return ok({ list: res.data.map((r) => toView(r)), total, page: p, pageSize: ps, hasMore: p * ps < total })
	},

	/* ── 接口：首页统计（今日到货/退货条数、待入库确认单数）——全体登录用户可见
	 * 今日口径：与入库列表页「对应类型 + 已入库 + 今天」完全一致——
	 * 按登记日期（date）归入当天，状态兼容历史两态数据（已完成 → 已入库），
	 * 并按入库类型（kind）分组：arrival=今日到货（历史缺 kind 兜底到货），return=今日退货 ── */
	async stats() {
		const denied = await checkLogin(this)
		if (denied) return denied
		const db = uniCloud.database()
		const cmd = db.command
		const $ = db.command.aggregate
		// 云函数默认 UTC+0，按东八区计算「今天」日期，与列表页日期筛选（date 登记日期）口径一致
		const now = new Date(Date.now() + 8 * 3600 * 1000)
		const p = (x) => String(x).padStart(2, '0')
		const today = `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}`
		const [todayRes, pendingRes] = await Promise.all([
			col().aggregate()
				// 与入库列表页「到货 + 已入库 + 今天」口径完全一致：
				// 按登记日期（date）归日；状态兼容历史两态数据（已完成 → 已入库）
				.match({
					status: cmd.in(['已入库', '已完成']),
					date: today,
				})
				.group({ _id: '$kind', count: $.sum('$count') })
				.end(),
			// 待入库确认单数：与列表页「待入库」筛选口径一致，兼容历史待确认数据
			col().where({ status: cmd.in(['待入库', '待确认']) }).count(),
		])
		// 按入库类型分组：arrival=到货，return=退货（历史数据缺 kind 兜底到货）
		let todayArrival = 0
		let todayReturn = 0
		todayRes.data.forEach((r) => {
			if (r._id === 'return') todayReturn = r.count || 0
			else todayArrival = r.count || 0
		})
		return ok({
			todayArrival,
			todayReturn,
			todayBills: todayArrival + todayReturn,
			todayCount: todayArrival + todayReturn,
			pendingBills: pendingRes.total || 0,
		})
	},

	/* ── 接口：入库单详情（只读，登录用户可见；编辑/确认仍限仓管级） ── */
	async get(params) {
		const denied = await checkLogin(this)
		if (denied) return denied
		const { id } = params || {}
		if (!id) return fail('缺少入库单id')
		const res = await col().doc(id).get()
		if (!res.data.length) return fail('入库单不存在')
		return ok(toView(res.data[0]))
	},

	/* ── 接口：登记入库（清单 items 逐款生成入库单，共享同一单号） ──
	 * items: [{ name, color, sizes: number[] }]；kind: 'arrival'（到货，默认）/ 'return'（退货）
	 */
	async create(params) {
		const denied = await checkStaff(this)
		if (denied) return denied
		const { items = [], kind = 'arrival', supplier = '', customerId = '' } = params || {}
		if (!Array.isArray(items) || !items.length) return fail('入库清单为空')
		const docKind = kind === 'return' ? 'return' : 'arrival'
		const docSupplier = String(supplier || '').trim()
		const docCustomerId = customerId || ''
		const now = new Date(Date.now() + 8 * 3600 * 1000) // 云函数默认 UTC+0，转东八区生成日期
		const p = (x) => String(x).padStart(2, '0')
		const date = `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}`
		const time = `${p(now.getUTCHours())}:${p(now.getUTCMinutes())}`
		const no = await nextNo()
		const ts = Date.now()
		const docs = items
			.map((it) => {
				const rolls = (it.sizes || []).map((v) => Number(v)).filter((v) => v > 0)
				return {
					no,
					name: (it.name || '').trim(),
					color: (it.color || '').trim(),
					rolls,
					count: rolls.length,
					total_meters: parseFloat(rolls.reduce((s, v) => s + v, 0).toFixed(1)),
					kind: docKind,
					supplier: docSupplier,
					customer_id: docCustomerId,
					location: '',
					status: '待入库',
					date,
					time,
					create_date: ts,
					update_date: ts,
				}
			})
			.filter((d) => d.name && d.color && d.rolls.length > 0)
		if (!docs.length) return fail('清单数据无效，请检查品名、颜色和细码')
		await col().add(docs)
		return ok({ no, count: docs.length })
	},

	/* ── 接口：编辑入库单（仅「待入库」状态可修改品名/颜色/细码/供应商） ── */
	async update(params) {
		const denied = await checkStaff(this)
		if (denied) return denied
		const { id, name, color, rolls, supplier = '' } = params || {}
		if (!id) return fail('缺少入库单id')
		const res = await col().doc(id).get()
		if (!res.data.length) return fail('入库单不存在')
		const doc = res.data[0]
		if (doc.status !== '待入库') return fail('仅待入库状态的单据可编辑')
		const cleanRolls = (rolls || []).map((v) => Number(v)).filter((v) => v > 0)
		const newName = (name || '').trim()
		const newColor = (color || '').trim()
		if (!newName || !newColor) return fail('品名和颜色不能为空')
		if (!cleanRolls.length) return fail('细码不能为空')
		await col().doc(id).update({
			name: newName,
			color: newColor,
			rolls: cleanRolls,
			count: cleanRolls.length,
			total_meters: parseFloat(cleanRolls.reduce((s, v) => s + v, 0).toFixed(1)),
			supplier: (supplier || '').trim(),
			update_date: Date.now(),
		})
		return ok({ id })
	},

	/* ── 接口：确认入库（待入库 → 已入库，可填写库位，并自动入账库存） ──
	 * P0-2 事务化：事务内重读主表做状态前置校验 + 库存入账 + 状态流转原子提交，
	 * 同一单据并发/重复确认只允许一次入账（另一路检测到状态已变即返回，不再重复重建库存） ── */
	async confirm(params) {
		const denied = await checkStaff(this)
		if (denied) return denied
		const { id, location = '' } = params || {}
		if (!id) return fail('缺少入库单id')
		const loc = (location || '').trim()
		// 校验库位存在且启用（停用/不存在的库位禁止入库）
		if (loc) {
			const locRes = await uniCloud.database()
				.collection('location')
				.where({ code: loc, status: uniCloud.database().command.neq(0) })
				.limit(1)
				.get()
			if (!locRes.data.length) return fail('库位不存在或已停用，请重新选择')
		}
		const db = uniCloud.database()
		const now = Date.now()
		// 预读单据与既有在库卷 id（事务内须按 doc 操作，先读齐所需信息）
		const orderRes = await col().doc(id).get()
		if (!orderRes.data.length) return fail('入库单不存在')
		const order = orderRes.data[0]
		// limit(1000)：单据细码超 100 卷时会被静默截断，幂等清理漏删旧卷 → 重复入账
		const rollRes = await db.collection('stock_roll')
			.where({ inbound_id: id })
			.field({ _id: true })
			.limit(1000)
			.get()
		const existRolls = rollRes.data || []

		let result = null
		const transaction = await db.startTransaction()
		try {
			// 事务内重读主表：状态前置校验 + 以最新行数据入账，防并发双方同时重建造成重复入账
			const cur = await tDocGet(transaction, 'inbound_order', id)
			if (!cur) throw new Error('入库单不存在')
			const s = cur.status || ''
			if (s === '待入库' || s === '待确认') {
				// 首次确认（兼容历史「待确认」旧态）：写库存 + 状态流转 原子完成
				if (!cur.name || !cur.color) throw new Error('入库单缺少品名/颜色，无法入账')
				const prep = await prepareStockDicts(cur.name, cur.color)
				const stockRolls = await writeStockInTx(transaction, cur, loc, existRolls, prep, now)
				await transaction.collection('inbound_order').doc(id).update({
					status: '已入库',
					location: loc,
					update_date: now,
				})
				result = ok({ id, stockRolls })
			} else if (s === '已入库' || s === '已完成') {
				// 已确认过（兼容历史「已完成」旧态）：不重复入账重建，幂等返回
				result = ok({ id, stockRolls: 0, duplicated: true })
			} else {
				throw new Error('单据当前状态不可确认')
			}
			await transaction.commit()
			return result
		} catch (e) {
			await transaction.rollback().catch(() => {})
			return fail('确认入库失败：' + (e.message || e))
		}
	},
}
