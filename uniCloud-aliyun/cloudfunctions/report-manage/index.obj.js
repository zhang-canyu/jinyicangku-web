'use strict'

/* ════════════════════════════════════════════════════════════════
 * 报表聚合（云对象 report-manage）
 *   pages/report/report.vue 唯一数据源
 *
 * 口径与列表页/首页统计完全一致（保证报表数字与单据对得上）：
 *   入库：inbound_order 状态 in ['已入库','已完成']（兼容历史两态），
 *         按登记日期 date（yyyy-MM-dd）归期
 *   出库：order 终态单（打样=已完成 / 大货·返厂=已发货），
 *         按完成时间 update_date（东八区时间戳）归期
 *
 * 权限：
 *   面向所有登录角色（admin / warehouse / salesperson）开放，数据口径一致；
 *   报表为经营看板，统一按整仓数据展示，无角色差异
 * ════════════════════════════════════════════════════════════════ */

/* ── 集合引用（惰性获取） ── */
let _inbound = null
let _outbound = null
let _item = null

function inboundCol() {
	if (!_inbound) _inbound = uniCloud.database().collection('inbound_order')
	return _inbound
}
function outboundCol() {
	if (!_outbound) _outbound = uniCloud.database().collection('order')
	return _outbound
}
function itemCol() {
	if (!_item) _item = uniCloud.database().collection('order_item')
	return _item
}

/* ── 统一返回结构 / 鉴权：抽到 common/auth-common 公共模块 ── */
const { ok, getActor } = require('auth-common')

module.exports = {
	/* ── 接口：出库报表 dailyFlow({ date, startDate })
	 * 日期参数（二选一，缺省=今天）：date 精确日（YYYY-MM-DD） / startDate 起始日（含，至今天）
	 * 区间内两类出库终态单：
	 *   打样：source=sample 且 status=已完成（配货完成即终态）
	 *   大货/返厂：status=已发货（确认发货），source≠sample（$ne 含历史缺省）
	 * 均按 update_date（终态达成时间，东八区）归期，返回 客户×品名 聚合表 ── */
	async dailyFlow(params = {}) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const cmd = uniCloud.database().command
		const { date = '', startDate = '' } = params || {}
		/* 日期窗口（东八区当日 0 点 ≤ t < 次日 0 点）：date 精确日 / startDate 开放区间 / 缺省今天 */
		const dayStart = (d) => Date.parse(`${d}T00:00:00+08:00`)
		let win
		if (date) {
			win = { gte: dayStart(date), lt: dayStart(date) + 24 * 3600 * 1000 }
		} else if (startDate) {
			win = { gte: dayStart(startDate) }
		} else {
			const now = new Date(Date.now() + 8 * 3600 * 1000)
			const t0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 8 * 3600 * 1000
			win = { gte: t0, lt: t0 + 24 * 3600 * 1000 }
		}
		const winCond = win.lt !== undefined ? cmd.gte(win.gte).and(cmd.lt(win.lt)) : cmd.gte(win.gte)

		/* 分页拉全：云函数单次 get 上限 100 条，区间单量可能超限
		 * 仅取聚合所需字段（_id / customer）；orderBy 保证 skip 翻页稳定 */
		const fetchRows = async (where) => {
			const out = []
			for (let offset = 0; ; offset += 100) {
				const res = await outboundCol()
					.where(where)
					.field({ customer: true, no: true, batchNo: true, source: true })
					.orderBy('update_date', 'desc')
					.skip(offset)
					.limit(100)
					.get()
				out.push(...res.data)
				if (res.data.length < 100) break
			}
			return out
		}

		const [samples, ships] = await Promise.all([
			fetchRows({ source: 'sample', status: '已完成', update_date: winCond }),
			fetchRows({ source: cmd.neq('sample'), status: '已发货', update_date: winCond }),
		])

		/* ── 报表表格：区间单明细按 客户 × 品名 聚合（条数、米数） ── */
		/* order_id → 客户 映射（取自区间终态单本身）；samples 本身即打样单集合
		 * 打样单为开剪取样：明细 count=剪样段数，非真实条数 → 条数列不累计，仅计米数 */
		const custOf = {}
		const orderOf = {}
		const sampleOf = {}
		;[...samples, ...ships].forEach((o) => {
			custOf[o._id] = o.customer || ''
			/* 行点击跳订单详情所需：订单引用（单号兜底 batchNo，与列表页 openDetail 口径一致） */
			orderOf[o._id] = { id: o._id, no: o.no || o.batchNo || '', source: o.source || '' }
		})
		samples.forEach((o) => {
			sampleOf[o._id] = true
		})
		/* 分页拉全区间单的明细行（云函数单次 get 上限 100，in 条件分批防超限） */
		const itemRows = []
		const todayIds = Object.keys(custOf)
		for (let c0 = 0; c0 < todayIds.length; c0 += 400) {
			const ids = todayIds.slice(c0, c0 + 400)
			for (let offset = 0; ; offset += 100) {
				const res = await itemCol()
					.where({ order_id: cmd.in(ids) })
					.skip(offset)
					.limit(100)
					.get()
				itemRows.push(...res.data)
				if (res.data.length < 100) break
			}
		}
		/* 历史行缺 total_meters 时用 rolls 细码求和兜底 */
		const metersOf = (it) => {
			if (it.total_meters) return it.total_meters
			return (it.rolls || []).reduce((s, v) => s + (Number(v) || 0), 0)
		}
		const cell = {}
		itemRows.forEach((it) => {
			const cust = custOf[it.order_id] || ''
			const name = it.name || ''
			const key = `${cust}\u0001${name}`
			const c = (cell[key] = cell[key] || { customer: cust, name, count: 0, meters: 0, orders: {} })
			/* 行内订单去重收集（供前端点击行跳订单详情） */
			c.orders[it.order_id] = orderOf[it.order_id] || { id: it.order_id, no: '', source: '' }
			/* 打样开剪行不计条数（count=剪样段数无业务含义），仅大货/仓管单累计真实出库条数 */
			if (!sampleOf[it.order_id]) c.count += it.count || 0
			c.meters += metersOf(it)
		})
		const table = Object.values(cell)
			.map((c) => ({
				customer: c.customer,
				name: c.name,
				count: c.count,
				meters: Math.round(c.meters * 10) / 10,
				orders: Object.values(c.orders),
			}))
			.sort((a, b) => b.meters - a.meters)

		return ok({ table })
	},

	/* ── 接口：入库报表 dailyInbound({ date, startDate })
	 * 日期参数（二选一，缺省=今天）：date 精确日（YYYY-MM-DD） / startDate 起始日（含，至今天）
	 * 已入库单（状态两态兼容：已入库/已完成），按登记日期 date 归期，
	 * 按 品名 × 颜色 聚合：条数（入账卷数）与米数 ── */
	async dailyInbound(params = {}) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const cmd = uniCloud.database().command
		const { date = '', startDate = '' } = params || {}
		let dateCond
		if (date) {
			dateCond = { date }
		} else if (startDate) {
			dateCond = { date: cmd.gte(startDate) }
		} else {
			const now = new Date(Date.now() + 8 * 3600 * 1000)
			const p = (x) => String(x).padStart(2, '0')
			dateCond = { date: `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}` }
		}

		/* 分页拉全区间内已入库单（云函数单次 get 上限 100） */
		const rows = []
		for (let offset = 0; ; offset += 100) {
			const res = await inboundCol()
				.where({ status: cmd.in(['已入库', '已完成']), ...dateCond })
				.field({ name: true, color: true, count: true, total_meters: true, rolls: true, no: true, batchNo: true })
				.skip(offset)
				.limit(100)
				.get()
			rows.push(...res.data)
			if (res.data.length < 100) break
		}

		/* 品名 × 颜色 聚合；米数缺 total_meters 时用细码 rolls 求和兜底（历史数据） */
		const cell = {}
		rows.forEach((o) => {
			const name = o.name || ''
			const color = o.color || ''
			const key = `${name}\u0001${color}`
			const c = (cell[key] = cell[key] || { name, color, count: 0, meters: 0, orders: {} })
			c.orders[o._id] = { id: o._id, no: o.no || o.batchNo || '' }
			c.count += o.count || 0
			c.meters += o.total_meters || (o.rolls || []).reduce((s, v) => s + (Number(v) || 0), 0)
		})
		const table = Object.values(cell)
			.map((c) => ({ name: c.name, color: c.color, count: c.count, meters: Math.round(c.meters * 10) / 10, orders: Object.values(c.orders) }))
			.sort((a, b) => b.meters - a.meters)

		return ok({ table })
	},
}
