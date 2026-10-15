'use strict'

/* ════════════════════════════════════════════════════════════════
 * 出库单管理（云对象）— 主从表结构
 *   order（主表）    ：一张出库单一条记录，含客户/状态/日期等主表字段
 *                     冗余汇总字段 count/total_meters/item_count
 *                     （随明细增删改同步维护，列表页无需联表聚合）
 *   order_item（明细）：一单 N 条款式行，order_id 关联 order._id
 *
 * 前端调用方（common/api/outbound.js）无需改动，返回结构保持兼容：
 *   list  → { list, total, page, pageSize, hasMore }
 *   get   → 整单聚合视图（含 items 数组，与旧 buildOrderView 一致）
 *   create/confirm/update/ship → { id, no }
 * ════════════════════════════════════════════════════════════════ */

let _order = null
let _item = null
function orderCol() {
	if (!_order) _order = uniCloud.database().collection('order')
	return _order
}
function itemCol() {
	if (!_item) _item = uniCloud.database().collection('order_item')
	return _item
}

/* ── 分享 token（16 hex = 64 bit 熵）──
 * 出库单创建时写入主表 share_token；get 接口接受 share_token 即可绕过营业员的
 * created_by 校验，实现「转发给非下单人查看」的白名单访问；写操作不受此白名单影响 */
function genShareToken() {
	return require('crypto').randomBytes(8).toString('hex')
}

/* ── 统一返回结构 / 鉴权：抽到 common/auth-common 公共模块 ── */
const { ok, fail, getActor, isStaff, isSalesRole, actorName } = require('auth-common')
/* 配货完成订阅消息通知（事务外副作用，内部静默失败） */
const { notifyOrderAllocated } = require('notify-common')

/* 单行米数：优先 total_meters，兼容历史行（seed 数据无该字段） */
function rowMeters(row) {
	if (row.total_meters) return row.total_meters
	return parseFloat((row.rolls || []).reduce((s, v) => s + v, 0).toFixed(1))
}

/* 打样快递单：交付方式为快递（remark 含「快递」，下单时写入“交付：快递”）。
 * 历史打样单缺 remark 时按市场处理 */
function isSampleExpress(o) {
	return !!(o && o.source === 'sample' && /快递/.test(String(o.remark || '')))
}

/* ── 主表记录 → 列表视图模型（不携带明细，避免列表页联表） ── */
function toView(o) {
	return {
		id: o._id,
		type: '出库',
		no: o.no || '',
		batchNo: o.no || '',
		name: '',
		color: '',
		customer: o.customer || '',
		customerId: o.customer_id || '',
		operator: o.operator || '',
		count: o.count || 0,
		rolls: [],
		date: o.date || '',
		time: o.time || '',
		location: '',
		status: o.status || '待确认',
		remark: o.remark || '',
		total_meters: o.total_meters || 0,
		/** 下单需求米数汇总（打样/大货营业员单；历史数据缺失时兜底 total_meters） */
		demand_meters: o.demand_meters || 0,
		/** 下单需求条数汇总（营业员只填条数的单，列表按条显示） */
		demand_count: o.demand_count || 0,
		source: o.source || 'direct',
		/** 出库类型：out=出库 / return=返厂（历史数据缺失兜底出库） */
		kind: o.kind || 'out',
		createdName: o.created_name || '',
		create_date: o.create_date || 0,
		/** 打样订单快递信息：面单图片 fileID / 运单号 / 收件人 / 电话 / 收件地址（门店按面单填写） */
		expressImage: o.express_image || '',
		expressNo: o.express_no || '',
		receiver: o.receiver || '',
		receiverPhone: o.receiver_phone || '',
		address: o.address || '',
		/** 快递单门市确认（打样快递单）：是否已确认/确认时间/确认人 */
		expressConfirmed: !!o.express_confirmed,
		expressConfirmTime: o.express_confirm_time || 0,
		expressConfirmBy: o.express_confirm_by || '',
		/** 打样标签已打印（打印成功回执标记，列表页展示；历史单未打印为 false） */
		labelPrinted: !!o.label_printed,
	}
}

/* ── 明细行 → 前端 items 元素 ── */
function toItem(row) {
	return {
		id: row._id,
		name: row.name || '',
		color: row.color || '',
		location: row.location || '',
		locations: Array.isArray(row.locations) ? row.locations : [],
		rolls: row.rolls || [],
		/** 配货卷 id（与 rolls 一一对应，手动添加的细码无 id），配货页带入已有细码时使用 */
		roll_ids: Array.isArray(row.roll_ids) ? row.roll_ids : [],
		count: row.count || 0,
		total_meters: rowMeters(row),
		demandMeters: row.demand_meters || 0,
		demandCount: row.demand_count || 0,
		/** 打样取样记录：[{ roll_id, location, length, cut, remain }] */
		sampleCuts: Array.isArray(row.sample_cuts) ? row.sample_cuts : [],
		/** 开单定价：单价 / 计价单位（meters=按米、count=按条）/ 行金额（云端计算） */
		price: row.price === undefined || row.price === null ? undefined : Number(row.price),
		unit: row.unit === 'count' ? 'count' : row.unit === 'meters' ? 'meters' : undefined,
		amount: row.amount === undefined || row.amount === null ? undefined : Math.round(Number(row.amount) * 100) / 100,
	}
}

/* ── 主表 + 明细 → 整单聚合视图（详情/打印共用，结构与旧 buildOrderView 一致） ── */
function buildOrderView(order, rows) {
	const items = rows.map(toItem)
	return {
		id: order._id,
		type: '出库',
		no: order.no || '',
		batchNo: order.no || '',
		/** 分享 token（转发链接用，非敏感字段；前端可在 onShareAppMessage 取此值拼路径） */
		share_token: order.share_token || '',
		name: items[0] ? items[0].name : '',
		color: items[0] ? items[0].color : '',
		customer: order.customer || '',
		customerId: order.customer_id || '',
		operator: order.operator || '',
		count: items.reduce((s, it) => s + (it.count || it.rolls.length || 0), 0),
		rolls: items.reduce((s, it) => s.concat(it.rolls), []),
		date: order.date || '',
		time: order.time || '',
		location: items[0] ? items[0].location : '',
		status: order.status || '待确认',
		remark: order.remark || '',
		total_meters: parseFloat(items.reduce((s, it) => s + (it.total_meters || 0), 0).toFixed(1)),
		source: order.source || 'direct',
		/** 出库类型：out=出库 / return=返厂 */
		kind: order.kind || 'out',
		createdName: order.created_name || '',
		create_date: order.create_date || 0,
		expressImage: order.express_image || '',
		expressNo: order.express_no || '',
		receiver: order.receiver || '',
		receiverPhone: order.receiver_phone || '',
		address: order.address || '',
		/** 快递单门市确认（打样快递单）：是否已确认/确认时间/确认人 */
		expressConfirmed: !!order.express_confirmed,
		expressConfirmTime: order.express_confirm_time || 0,
		expressConfirmBy: order.express_confirm_by || '',
		/** 打样标签已打印（打印成功回执，详情页/列表页展示） */
		labelPrinted: !!order.label_printed,
		labelPrintTime: order.label_print_time || 0,
		/** 整单货款合计（开单后冗余写主表；明细无价的旧单兜底为 0） */
		total_amount: Math.round(Number(order.total_amount || 0) * 100) / 100,
		items,
	}
}

/* 按 id / 单号 / 分享 token 查主表（id 优先）；分享 token 用于转发链接的只读访问 */
async function findOrder(id, no, share_token) {
	let res = null
	if (id) {
		res = await orderCol().doc(id).get()
	} else if (no) {
		res = await orderCol().where({ no }).limit(1).get()
	} else if (share_token) {
		res = await orderCol().where({ share_token }).limit(1).get()
	}
	return res && res.data && res.data[0] ? res.data[0] : null
}

/* 拉取某单全部明细（按创建时间升序，保持登记顺序）
 * limit(1000)：云函数端 get 默认上限 100 条，大单明细超 100 会被静默截断，
 * 导致详情缺行、打印缺内容，更严重的是配货/开单 existing 基线不全 → 库存 diff 结算错误 */
async function loadItems(orderId) {
	if (!orderId) return []
	const res = await itemCol().where({ order_id: orderId }).orderBy('create_date', 'asc').limit(1000).get()
	return res.data
}

/* 由明细行重算主表汇总字段 */
function calcSummary(rows) {
	const count = rows.reduce((s, r) => s + (r.count || r.rolls.length || 0), 0)
	const total_meters = parseFloat(rows.reduce((s, r) => s + rowMeters(r), 0).toFixed(1))
	/** 下单需求米数汇总（营业员下单只记需求，配货/发货后保持不变） */
	const demand_meters = parseFloat(rows.reduce((s, r) => s + (Number(r.demand_meters) || 0), 0).toFixed(1))
	/** 下单需求条数汇总 */
	const demand_count = rows.reduce((s, r) => s + (Number(r.demand_count) || 0), 0)
	return { count, total_meters, demand_meters, demand_count, item_count: rows.length }
}

/* ── 同步明细：与现有明细 diff（按 品名+颜色 匹配，改色/新增按位置兜底），
 * 支持新增行追加、被移除行删除；完成后重建主表汇总字段 ──
 * items: [{ name, color, rolls, location, locs, roll_ids }]
 * db 可为全局 db（confirm 用）或事务对象（update 全量配货写入用，与库存 diff 原子提交） */
async function syncItems(orderId, items) {
	const now = Date.now()
	const existing = await loadItems(orderId)
	return syncItemsTo(uniCloud.database(), orderId, existing, items, now)
}

/* syncItems 的事务化主体：existing 由调用方预先读取（事务内不支持 where 查询）；
 * 明细写入走 db（全局或事务），删除逐行 doc 处理，汇总基于内存重建，不额外回查 */
async function syncItemsTo(db, orderId, existing, items, now) {
	const used = new Set()
	const targetPatches = {}
	const addedDocs = []
	for (const it of items) {
		const rolls = (it.rolls || []).map((v) => Number(v)).filter((v) => v > 0)
		const name = String(it.name || '').trim()
		const color = String(it.color || '').trim()
		const locs = (it.locs || []).map((v) => String(v || '').trim())
		const locations = [...new Set(locs.filter(Boolean))]
		const location = locations[0]
			|| (it.location !== undefined ? String(it.location || '').trim() : '')
			|| ''
		const patch = {
			name,
			color,
			rolls,
			count: rolls.length,
			total_meters: parseFloat(rolls.reduce((s, v) => s + v, 0).toFixed(1)),
			location,
			locations,
		}
		// 卷 id 仅在提交方显式携带时写入；未携带（detail 修改/确认页不带 roll_ids）则保留云端原值，
		// 避免把已配卷 id 清空导致后续归还/取消无法定位库存卷
		if (Array.isArray(it.roll_ids)) patch.roll_ids = it.roll_ids
		// 开剪记录同理：仅配货入口（云端已结算并构建 cutRecords）显式携带时写入，其余路径保留云端原值
		if (Array.isArray(it.cutRecords)) patch.cuts = it.cutRecords
		// 需求字段：仅当前端传入时写入（营业员改需求会传，配货时不传则保留原需求）
		if (it.demandMeters !== undefined) patch.demand_meters = Number(it.demandMeters) || 0
		if (it.demandCount !== undefined) patch.demand_count = Number(it.demandCount) || 0
		let target = existing.find(
			(r) => !used.has(r._id)
				&& String(r.name || '').trim() === name
				&& String(r.color || '').trim() === color
		)
		if (!target) target = existing.find((r) => !used.has(r._id))
		if (target) {
			used.add(target._id)
			targetPatches[target._id] = patch
			await db.collection('order_item').doc(target._id).update(patch)
		} else {
			const doc = { order_id: orderId, ...patch, create_date: now }
			addedDocs.push(doc)
			await db.collection('order_item').add(doc)
		}
	}
	// 删除前端已移除的行（逐行删除，兼容事务）
	const freshRows = []
	for (const r of existing) {
		if (used.has(r._id)) {
			freshRows.push({ ...r, ...targetPatches[r._id] })
			continue
		}
		await db.collection('order_item').doc(r._id).remove()
	}
	freshRows.push(...addedDocs)
	// 重建主表汇总
	const sum = calcSummary(freshRows)
	await db.collection('order').doc(orderId).update({ ...sum, update_date: now })
	return sum
}

/* 行标识：品名+颜色（配货/需求按此匹配明细行，避免品名与颜色间的拼接歧义） */
function rowKey(r) {
	return `${String((r && r.name) || '').trim()}\u0001${String((r && r.color) || '').trim()}`
}

/* 行是否已配货（有细码卷或卷 id） */
function isAllocRow(r) {
	return (r && ((r.rolls || []).length || (r.roll_ids || []).length)) || false
}

/* 归还细码卷：仅将仍处于「已出库」的卷置回「在库」。
 * 逐卷读取校验后更新（兼容事务对象：事务内要求先查后改）；
 * db 可为全局 db 或事务对象；不触碰已被其他单据变动的卷，避免覆盖他人扣减 */
async function restoreRolls(db, ids, now) {
	if (!Array.isArray(ids) || !ids.length) return 0
	let n = 0
	for (const rid of ids) {
		const res = await db.collection('stock_roll').doc(rid).get()
		const roll = Array.isArray(res.data) ? res.data[0] : res.data
		if (!roll || roll.status !== '已出库') continue
		await db.collection('stock_roll').doc(rid).update({ status: '在库', update_date: now })
		n++
	}
	return n
}

/* 扣减细码卷：逐卷校验「在库」后置「已出库」，任一卷已被占用即抛错（由调用方事务保证整单回滚）。
 * db 可为全局 db 或事务对象 */
async function deductRolls(db, ids, label, now) {
	for (const rid of ids) {
		const res = await db.collection('stock_roll').doc(rid).get()
		const roll = Array.isArray(res.data) ? res.data[0] : res.data
		if (!roll || roll.status !== '在库') {
			throw new Error(`${label}：所选细码已被占用或出库，请刷新后重新配货`)
		}
		await db.collection('stock_roll').doc(rid).update({ status: '已出库', update_date: now })
	}
	return ids.length
}

/* 配货卷 diff 结算：以云端现有配货（existing 各行的 roll_ids）为基准，
 * 本次提交（items 汇总的 roll_ids）新增的卷扣为「已出库」、移除的卷归还「在库」、保留的卷不动。
 * db 可为全局 db（update 用）或事务对象（allocate 用）。 */
async function settleRollDiff(db, existing, items, now) {
	const oldAll = new Set((existing || []).reduce((s, r) => s.concat(r.roll_ids || []), []))
	const newAll = new Set()
	for (const it of items || []) {
		for (const rid of it.roll_ids || []) {
			const v = String(rid || '').trim()
			if (v) newAll.add(v)
		}
	}
	const addIds = [...newAll].filter((x) => !oldAll.has(x))
	const removeIds = [...oldAll].filter((x) => !newAll.has(x))
	if (addIds.length) await deductRolls(db, addIds, '新增细码', now)
	if (removeIds.length) await restoreRolls(db, removeIds, now)
	return { add: addIds.length, remove: removeIds.length }
}

/* ── 开剪结算（大货配货按米扣卷余量，与整卷 diff 互补）──
 * order_item.cuts 记录：{ roll_id, location, length: 扣前余量, cut: 米数, remain: 扣后余量 }
 * 前端提交协议：items[].cuts（本次新开剪）+ items[].cutKeep（保留的历史开剪），均 [{ rollId, meters }]；
 * 结算分两阶段由调用方编排（须夹在 settleRollDiff 前后）：
 *   restoreCutDiff（settleRollDiff 之前）→ 归还「移除/调剪」的旧米数；
 *   applyCutDiff（settleRollDiff 之后）→ 应用新开剪/新米数；
 * 两阶段拆分是为了兼容「整卷 ↔ 开剪」互换：
 *   整卷→开剪：先归还整卷（settleRollDiff）再开剪；
 *   开剪→整卷：先归还开剪米数再整卷扣减。 */

/* 收集新旧开剪映射并校验：oldMap = 云端现有（rollId → 原记录）；
 * newMap = 本次提交（rollId → 米数，cuts 与 cutKeep 合并）。
 * 校验：米数合法、同一卷不可重复开剪（跨款亦然）、开剪卷不得同时整卷选中（roll_ids 交集） */
function cutMaps(existing, items) {
	const oldMap = new Map()
	for (const r of existing || []) {
		for (const c of r.cuts || []) {
			const rid = String((c && c.roll_id) || '').trim()
			if (rid && (Number(c && c.cut) || 0) > 0) oldMap.set(rid, c)
		}
	}
	const newMap = new Map()
	const wholeIds = new Set()
	for (const it of items || []) {
		for (const rid of it.roll_ids || []) {
			const v = String(rid || '').trim()
			if (v) wholeIds.add(v)
		}
	}
	for (const it of items || []) {
		for (const src of [...(it.cuts || []), ...(it.cutKeep || [])]) {
			const rid = String((src && src.rollId) || '').trim()
			const meters = Number(src && src.meters) || 0
			if (!rid) throw new Error('开剪细码缺少卷信息，请重新选择')
			if (meters <= 0) throw new Error('开剪米数无效，请重新输入')
			if (newMap.has(rid)) throw new Error('同一细码卷不可重复开剪，请检查后重新提交')
			if (wholeIds.has(rid)) throw new Error('开剪细码不可同时整卷配货，请二选一')
			newMap.set(rid, meters)
		}
	}
	return { oldMap, newMap }
}

/* 阶段一（settleRollDiff 之前）：归还发生变更/被移除的开剪米数。
 * 仅当卷「在库」或「本单开剪耗尽（余 0）」时可调整；被其他单据整卷占用则抛错整单回滚。
 * db 必须为事务对象。 */
async function restoreCutDiff(db, { oldMap, newMap }, now) {
	for (const [rid, rec] of oldMap) {
		const oldM = Number(rec.cut) || 0
		const newM = newMap.get(rid) || 0
		if (oldM === newM) continue
		const res = await db.collection('stock_roll').doc(rid).get()
		const roll = Array.isArray(res.data) ? res.data[0] : res.data
		if (!roll) throw new Error('开剪细码不存在或已删除，请刷新库存后重试')
		const exhausted = Number(roll.length) === 0 && roll.status === '已出库'
		if (roll.status !== '在库' && !(exhausted && Number(rec.remain) <= 0)) {
			throw new Error('开剪细码已被其他单据占用，无法调整开剪，请刷新后重试')
		}
		const next = parseFloat(((Number(roll.length) || 0) + oldM).toFixed(2))
		const patch = { length: next, update_date: now }
		// 本单开剪耗尽的卷归还后重新回库
		if (roll.status !== '在库') patch.status = '在库'
		await db.collection('stock_roll').doc(rid).update(patch)
	}
}

/* 阶段二（settleRollDiff 之后）：应用新开剪 / 调剪米数。
 * 逐卷校验在库与余量，扣尽（≤0）转「已出库」；
 * 返回 cutInfo（rollId → { location, before, after }）覆盖本次全部开剪卷，
 * 供明细 cuts 记录落库（保留不动的卷沿用原记录的余量）。 */
async function applyCutDiff(db, { oldMap, newMap }, now) {
	const cutInfo = new Map()
	for (const [rid, rec] of oldMap) {
		const newM = newMap.get(rid)
		if (newM !== undefined && newM === (Number(rec.cut) || 0)) {
			cutInfo.set(rid, {
				location: String(rec.location || ''),
				before: Number(rec.length) || 0,
				after: Number(rec.remain) || 0,
			})
		}
	}
	let added = 0
	for (const [rid, newM] of newMap) {
		const oldRec = oldMap.get(rid)
		const oldM = oldRec ? Number(oldRec.cut) || 0 : 0
		if (oldM === newM) continue
		const res = await db.collection('stock_roll').doc(rid).get()
		const roll = Array.isArray(res.data) ? res.data[0] : res.data
		if (!roll || roll.status !== '在库') {
			throw new Error('开剪细码已被占用或出库，请刷新后重新配货')
		}
		const cur = Number(roll.length) || 0
		const next = parseFloat((cur - newM).toFixed(2))
		if (next < 0) throw new Error(`开剪细码仅余 ${cur} 米，无法剪 ${newM} 米`)
		const patch = { update_date: now }
		if (next <= 0) {
			patch.length = 0
			patch.status = '已出库'
		} else {
			patch.length = next
		}
		await db.collection('stock_roll').doc(rid).update(patch)
		added++
		cutInfo.set(rid, {
			location: String(roll.location || '').trim(),
			before: cur,
			after: Math.max(next, 0),
		})
	}
	return { added, cutInfo }
}

/* 由提交协议构建明细 cuts 落库记录（cuts + cutKeep），
 * 余量信息取 applyCutDiff 返回的 cutInfo；未命中（理论不可达）则跳过防脏数据 */
function cutRecordsFor(item, cutInfo) {
	const out = []
	for (const src of [...((item && item.cuts) || []), ...((item && item.cutKeep) || [])]) {
		const rid = String((src && src.rollId) || '').trim()
		const meters = Number(src && src.meters) || 0
		const info = cutInfo && cutInfo.get(rid)
		if (!rid || meters <= 0 || !info) continue
		out.push({ roll_id: rid, location: info.location, length: info.before, cut: meters, remain: info.after })
	}
	return out
}

/* 归还开剪米数（取消单 / 删除已配行用，尽力而为不抛错，与 restoreRolls 口径一致）：
 * 卷「在库」→ 余量加回；「已出库」且余 0（本单开剪耗尽）→ 回库并补回米数；
 * 被其他单据占用的卷跳过，避免覆盖他人扣减。db 可为全局 db 或事务对象。 */
async function restoreCutRecords(db, records, now) {
	if (!Array.isArray(records) || !records.length) return 0
	let n = 0
	for (const c of records) {
		const rid = String((c && c.roll_id) || '').trim()
		const meters = Number(c && c.cut) || 0
		if (!rid || meters <= 0) continue
		const res = await db.collection('stock_roll').doc(rid).get()
		const roll = Array.isArray(res.data) ? res.data[0] : res.data
		if (!roll) continue
		const exhausted = Number(roll.length) === 0 && roll.status === '已出库'
		if (roll.status !== '在库' && !exhausted) continue
		const patch = { length: parseFloat(((Number(roll.length) || 0) + meters).toFixed(2)), update_date: now }
		if (roll.status !== '在库') patch.status = '在库'
		await db.collection('stock_roll').doc(rid).update(patch)
		n++
	}
	return n
}

/* 需求结构编辑：已配行的细码字段以云端为准原样保留，仅更新需求数量与行结构。
 * 调用前调用方（营业员）已校验「提交包含全部已配行（同品名同颜色）」，因此本函数只会：
 *   匹配行 → 更新需求数量（配货字段不动）；
 *   未匹配且原行未配 → 改品名/颜色复用；
 *   新行 → 追加（纯需求）；
 *   被移除且未配的行 → 删除；
 *   dropAllocRows（仓管待配货单编辑需求）时，被整体移除的已配行归还其卷后整行删除。
 * db 可为全局 db（营业员编辑/仓管全局路径）或事务对象（仓管编辑需归还卷时，
 * 与归还动作在同一事务内原子提交，杜绝卷已归还而明细/主表未更新的半态）；
 * 完成后重建主表汇总（保留的已配卷仍在，配货汇总不变，仅需求汇总随之更新） */
async function syncDemandOnly(db, orderId, existing, items, now, dropAllocRows = false) {
	const used = new Set()
	const targetPatches = {}
	const addedDocs = []
	for (const it of items) {
		const name = String(it.name || '').trim()
		const color = String(it.color || '').trim()
		if (!name || !color) throw new Error('存在未填写品名或颜色的款式')
		const demandMeters = it.demandMeters !== undefined ? Number(it.demandMeters) || 0 : undefined
		const demandCount = it.demandCount !== undefined ? Number(it.demandCount) || 0 : undefined
		// 库位：显式传入（locs / location）才更新——detail 修改态可补手动库位，不影响已配卷的库存
		const hasLoc = it.locs !== undefined || it.location !== undefined
		let location = ''
		let locations = []
		if (hasLoc) {
			locations = [...new Set((it.locs || []).map((v) => String(v || '').trim()).filter(Boolean))]
			location = (it.location !== undefined ? String(it.location || '').trim() : '') || locations[0] || ''
		}
		// 同品名同颜色优先匹配（已配行只能按原样匹配，不可被改名占用）
		let target = existing.find((r) => !used.has(r._id) && rowKey(r) === rowKey(it))
		// 改品名/新增时复用尚未使用的未配行（位置兜底，保持行序稳定）
		if (!target) target = existing.find((r) => !used.has(r._id) && !isAllocRow(r))
		if (target) {
			used.add(target._id)
			const patch = { name, color, update_date: now }
			if (demandMeters !== undefined) patch.demand_meters = demandMeters
			if (demandCount !== undefined) patch.demand_count = demandCount
			if (hasLoc) {
				patch.location = location
				patch.locations = locations
			}
			targetPatches[target._id] = patch
			await db.collection('order_item').doc(target._id).update(patch)
		} else {
			const doc = {
				order_id: orderId,
				name,
				color,
				demand_meters: demandMeters !== undefined ? demandMeters : 0,
				demand_count: demandCount !== undefined ? demandCount : 0,
				rolls: [],
				roll_ids: [],
				count: 0,
				total_meters: 0,
				location,
				locations,
				create_date: now,
				update_date: now,
			}
			addedDocs.push(doc)
			await db.collection('order_item').add(doc)
		}
	}
	// 删除被移除的行：未配行直接删；仓管编辑需求时可整体移除已配行（先归还其卷，避免孤儿）
	const removedIds = []
	const dropRows = []
	for (const r of existing) {
		if (used.has(r._id)) continue
		if (isAllocRow(r)) {
			if (dropAllocRows) dropRows.push(r)
		} else {
			removedIds.push(r._id)
		}
	}
	if (dropRows.length) {
		await restoreRolls(db, dropRows.reduce((s, r) => s.concat(r.roll_ids || []), []), now)
		// 被整体移除的已配行同步归还其开剪米数，避免孤儿扣减
		await restoreCutRecords(db, dropRows.reduce((s, r) => s.concat(r.cuts || []), []), now)
	}
	const delSet = new Set(removedIds.concat(dropRows.map((r) => r._id)))
	// 逐行删除（兼容事务：事务内不支持 where 批量删除）
	for (const r of existing) {
		if (used.has(r._id)) continue
		if (!delSet.has(r._id)) continue
		await db.collection('order_item').doc(r._id).remove()
	}
	// 内存重建主表汇总（不额外回查库）
	const freshRows = existing
		.filter((r) => !delSet.has(r._id))
		.map((r) => (targetPatches[r._id] ? { ...r, ...targetPatches[r._id] } : r))
		.concat(addedDocs)
	const sum = calcSummary(freshRows)
	await db.collection('order').doc(orderId).update({ ...sum, update_date: now })
	return sum
}

/* 对外只读分享有效期：转发给客户的图片经微信「打开小程序」只能带回单号（图片消息无法携带自定义参数），
 * 故把「已转发登记」本身作为客户只读查看的凭证，30 天后自动失效，需业务员重新转发 */
const SHARE_TTL = 30 * 24 * 3600 * 1000

/* 生成出库单号：CK + yyyyMMdd + 3 位序号
 * 云函数运行环境默认 UTC+0，这里按东八区（UTC+8）生成日期，避免凌晨创建的
 * 单号/日期与前端本地日期错位，导致列表按「今天」筛选查不到 */
async function nextNo() {
	const now = new Date(Date.now() + 8 * 3600 * 1000)
	const p = (x) => String(x).padStart(2, '0')
	const prefix = `CK${String(now.getUTCFullYear()).slice(-2)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`
	const res = await orderCol().where({ no: new RegExp(`^${prefix}`) }).orderBy('no', 'desc').limit(1).get()
	const last = res.data[0] && res.data[0].no || ''
	const seq = last ? parseInt(last.slice(-3), 10) + 1 : 1
	return `${prefix}${String(seq).padStart(3, '0')}`
}

/* ── 回写客户统计：订单数 +1、最近下单日期（主表一单一客户，天然只计一次） ── */
async function touchCustomers(customerId, date) {
	const cid = String(customerId || '').trim()
	if (!cid) return 0
	const db = uniCloud.database()
	const res = await db.collection('customer')
		.where({ _id: cid })
		.update({
			order_count: db.command.inc(1),
			last_order: date,
			update_date: Date.now(),
		})
	return res.updated || 0
}

/* ── 调整客户订单计数（取消单 -1 / 重新开单 +1，与 touchCustomers 配对，
 * 保证详情页「订单数」统计有效订单而非累计开单数；辅助数据，失败不影响单据主流程） ── */
async function adjustCustomerCount(customerId, delta) {
	const cid = String(customerId || '').trim()
	if (!cid || !delta) return 0
	const db = uniCloud.database()
	const res = await db.collection('customer')
		.where({ _id: cid })
		.update({ order_count: db.command.inc(delta), update_date: Date.now() })
	return res.updated || 0
}

module.exports = {
	/* ── 接口：首页统计（今日出货/返厂条数、待确认/待配货/待发货单数）
	 * 今日出货/返厂：全员共享（不按角色过滤）—— 让营业员一眼看到全店今日已发的货
	 * 待确认/待配货/待发货：营业员等普通用户只统计自己的单；仓管/管理员统计全部
	 * 今日口径：以订单状态流转为「已发货」为准，按发货时间（update_date）归入当天，
	 * 并按出库类型（kind）分组：out=今日出货，return=今日返厂
	 * todayAllocateBills：当天创建的待配货订单数 ── */
	async stats() {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const db = uniCloud.database()
		const cmd = db.command
		const $ = db.command.aggregate
		// 云函数默认 UTC+0，按东八区计算「今天」0 点时间戳，与发货时间（东八区时间戳）对齐
		const now = new Date(Date.now() + 8 * 3600 * 1000)
		const p = (x) => String(x).padStart(2, '0')
		const today = `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}`
		const start = Date.parse(`${today}T00:00:00+08:00`)
		const end = start + 24 * 3600 * 1000
		const scope = isSalesRole(actor.roles) ? { created_by: actor.uid } : null
		// 今日出货/返厂全员共享：按状态=已发货 + 当天 update_date 聚合 kind，无 created_by 限制
		const shippedMatch = { status: '已发货', update_date: cmd.gte(start).and(cmd.lt(end)) }
		const allocateWhere = scope ? { status: '待配货', ...scope } : { status: '待配货' }
		const [todayRes, pendingRes, allocateRes, shippingRes, todayAllocateRes] = await Promise.all([
			orderCol().aggregate()
				.match(shippedMatch)
				.group({ _id: '$kind', count: $.sum('$count') })
				.end(),
			orderCol().where(scope ? { status: '待确认', ...scope } : { status: '待确认' }).count(),
			orderCol().where(allocateWhere).count(),
			orderCol().where(scope ? { status: '待发货', ...scope } : { status: '待发货' }).count(),
			orderCol().where({ ...allocateWhere, date: today }).count(),
		])
		// 按出库类型分组：out=出货，return=返厂（历史数据缺 kind 兜底出货）
		let todayShip = 0
		let todayBack = 0
		todayRes.data.forEach((r) => {
			if (r._id === 'return') todayBack = r.count || 0
			else todayShip = r.count || 0
		})
		return ok({
			todayShip,
			todayBack,
			todayBills: todayShip + todayBack,
			todayCount: todayShip + todayBack,
			pendingBills: pendingRes.total || 0,
			allocateBills: allocateRes.total || 0,
			todayAllocateBills: todayAllocateRes.total || 0,
			shippingBills: shippingRes.total || 0,
		})
	},

	/* ── 接口：出库单列表（主表一单一行，天然准确分页）
	 * 参数：keyword 搜索单号/客户/品名/颜色；
	 *      date 精确日期筛选（YYYY-MM-DD）；
	 *      startDate/endDate 日期范围筛选（YYYY-MM-DD）；
	 *      status 状态筛选（待确认/待发货/已发货/all）；
	 *      page/pageSize 分页（默认 1/50）
	 * 日期口径随状态联动：终态单（大货/仓管「已发货」、打样「已完成」）按完成时间（update_date，东八区）归期，
	 * 其余状态/全部按下单登记日期（date）过滤 —— 与首页「今日出货」、报表流水口径一致 ── */
	async list(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { keyword = '', date = '', startDate = '', endDate = '', status = '', type = '', operator = '', page = 1, pageSize = 50 } = params || {}
		const cmd = uniCloud.database().command
		const p = Math.max(1, parseInt(page, 10) || 1)
		const ps = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 50))

		// 条件统一 and 组装，营业员角色过滤（created_by）始终保留，防止越权
		const conds = []
		// 营业员等普通用户只能看到自己创建的单（越权防护：云端强制）
		if (isSalesRole(actor.roles)) {
			conds.push({ created_by: actor.uid })
		}
		if (keyword) {
			const reg = new RegExp(keyword)
			// 主表字段：单号/客户；明细字段：品名/颜色（先查明细收集 order_id 再桥接主表）
			const kwConds = [{ no: reg }, { customer: reg }]
			try {
				const hit = await itemCol()
					.where(cmd.or([{ name: reg }, { color: reg }]))
					.field({ order_id: true })
					.limit(1000)
					.get()
				const ids = [...new Set(hit.data.map((r) => r.order_id).filter(Boolean))]
				if (ids.length) kwConds.push({ _id: cmd.in(ids) })
			} catch (e) {
				// 明细查询异常时忽略品名/颜色匹配，仅按主表字段搜索
			}
			conds.push(cmd.or(kwConds))
		}
		if (status && status !== 'all') {
			conds.push({ status })
		}
		// 单据类型筛选：all（默认）/ sales（大货下单）/ sample（打样下单）/ direct（仓管直接出库）
		if (type && type !== 'all') {
			conds.push({ source: type })
		}
		// 操作员筛选：admin 端按操作员姓名精确匹配；'all' 不过滤
		if (operator && operator !== 'all') {
			conds.push({ operator })
		}
		if (date || startDate || endDate) {
			/* 日期口径：终态单（已发货/已完成）按完成时间 update_date（东八区当天 0 点 ≤ t < 次日 0 点），
			 * 其余按下单登记日期 date（YYYY-MM-DD 字符串） */
			if (status === '已发货' || status === '已完成') {
				const dayStart = (d) => Date.parse(`${d}T00:00:00+08:00`)
				let cond
				if (date) {
					cond = { update_date: cmd.gte(dayStart(date)).and(cmd.lt(dayStart(date) + 24 * 3600 * 1000)) }
				} else if (startDate && endDate) {
					cond = { update_date: cmd.gte(dayStart(startDate)).and(cmd.lt(dayStart(endDate) + 24 * 3600 * 1000)) }
				} else if (startDate) {
					cond = { update_date: cmd.gte(dayStart(startDate)) }
				} else {
					cond = { update_date: cmd.lt(dayStart(endDate) + 24 * 3600 * 1000) }
				}
				conds.push(cond)
			} else if (date) {
				conds.push({ date })
			} else {
				const cond = {}
				if (startDate && endDate) {
					cond.date = cmd.gte(startDate).and(cmd.lte(endDate))
				} else if (startDate) {
					cond.date = cmd.gte(startDate)
				} else {
					cond.date = cmd.lte(endDate)
				}
				conds.push(cond)
			}
		}
		const where = conds.length === 1 ? conds[0] : conds.length > 1 ? cmd.and(conds) : {}

		/* 计数与取数互不依赖，并发执行（旧实现先 count 再查询，串行多一次往返） */
		const [cnt, res] = await Promise.all([
			orderCol().where(where).count(),
			orderCol()
				.where(where)
				.orderBy('create_date', 'desc')
				.skip((p - 1) * ps)
				.limit(ps)
				.get(),
		])
		const total = cnt.total || 0
		const list = res.data.map(toView)

		/* 批量同步客户档案最新名称（company||name，与登记显示规则一致），
		 * 让前端一次请求即可拿到最终客户名，免去列表页二次拉取客户档案；
		 * 客户已删除/查询失败时保留订单快照。
		 * 客户同步与需求回填互不依赖，两个附加查询并发执行（旧实现串行两次往返） */
		const custIds = [...new Set(list.map((o) => o.customerId).filter(Boolean))]
		/* 需求米数/条数回填：历史订单主表无 demand_meters/demand_count（该字段仅随写操作回填），
		 * 从明细聚合（配货/发货不覆盖需求字段，明细始终保留下单需求）；
		 * 适用于打样单与营业员大货单；明细也无需求字段的极旧数据，前端兜底显示 total_meters */
		const missIds = list.filter((o) => !o.demand_meters || !o.demand_count).map((o) => o.id)
		const [cres, dres] = await Promise.all([
			custIds.length
				? uniCloud.database().collection('customer')
						.where({ _id: cmd.in(custIds) })
						.field({ name: true, company: true })
						.get()
						.catch(() => null) // 客户同步失败：保留快照
				: null,
			missIds.length
				? itemCol()
						.where({ order_id: cmd.in(missIds) })
						.field({ order_id: true, demand_meters: true, demand_count: true })
						.get()
						.catch(() => null) // 聚合失败：前端兜底 total_meters
				: null,
		])
		if (cres && cres.data) {
			const cmap = {}
			;(cres.data || []).forEach((c) => {
				if (c && c._id) cmap[c._id] = c
			})
			list.forEach((o) => {
				const c = o.customerId ? cmap[o.customerId] : null
				if (c) o.customer = c.company || c.name || o.customer
			})
		}
		if (dres && dres.data) {
			const dmap = {}
			;(dres.data || []).forEach((r) => {
				if (!r || !r.order_id) return
				dmap[r.order_id] = dmap[r.order_id] || { m: 0, c: 0 }
				dmap[r.order_id].m = parseFloat(((dmap[r.order_id].m + (Number(r.demand_meters) || 0)).toFixed(1)))
				dmap[r.order_id].c = (dmap[r.order_id].c || 0) + (Number(r.demand_count) || 0)
			})
			list.forEach((o) => {
				const d = dmap[o.id]
				if (!d) return
				if (!o.demand_meters && d.m) o.demand_meters = d.m
				if (!o.demand_count && d.c) o.demand_count = d.c
			})
		}

		/* 打样单历史状态惰性收口：打样单两级流转 待配货/已完成，
		 * 旧「配货中/待发货/待剪样/已发货」→「已完成」（幂等，命中即改库）。
		 * 仅当本页数据仍含旧状态打样单时才按 _id 精确迁移（旧实现每次 list 都无条件
		 * 全表 where + update 一遍，存量已迁移后仍白付一次无索引扫描往返） */
		const legacySamples = list.filter(
			(o) => o.source === 'sample' && ['配货中', '待发货', '待剪样', '已发货'].includes(o.status)
		)
		if (legacySamples.length) {
			try {
				await orderCol()
					.where({ _id: cmd.in(legacySamples.map((o) => o.id)) })
					.update({ status: '已完成', update_date: Date.now() })
			} catch (e) {
				// 迁移失败不影响正常读写
			}
		}
		list.forEach((o) => {
			if (o.source !== 'sample') return
			if (o.status === '配货中' || o.status === '待发货' || o.status === '待剪样' || o.status === '已发货') o.status = '已完成'
		})
		return ok({
			list,
			total,
			page: p,
			pageSize: ps,
			hasMore: p * ps < total,
		})
	},

	/* ── 接口：操作员列表（去重）
	 * admin 端筛选栏用：从历史订单里 distinct 出所有出现过的操作员姓名
	 * 仅 admin/仓管角色可调用（普通营业员也开放以便自助筛选自己的单） */
	async operators() {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		try {
			const res = await orderCol().field({ operator: true }).limit(1000).get()
			const set = new Set()
			res.data.forEach((o) => {
				const op = String(o.operator || '').trim()
				if (op) set.add(op)
			})
			return ok({ list: Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')) })
		} catch (e) {
			return fail('OPERATORS_FAIL', e.message)
		}
	},

	/* ── 接口：出库单详情（按 id / 单号 / 分享 token 查询，返回整单聚合视图）
	 * 读权限：全员共享（任意已登录用户可看任意单据的详情——与「报表行点击 → 详情」语义一致）
	 * 持 share_token 的访问（未带 id/no）视作分享只读视图，前端按 accessMode 隐藏写操作 UI
	 * 写操作（confirm/ship/cancel/reopen/update/sampleAllocate/saveExpress/confirmExpress/markLabelPrinted）：
	 *   营业员仅限 created_by=uid；仓管/管理员按 staff 角色控制——不会被本次改动影响 ── */
	async get(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { id, no, share_token } = params || {}
		if (!id && !no && !share_token) return fail('缺少出库单id或单号')
		const order = await findOrder(id, no, share_token)
		if (!order) return fail('出库单不存在')
		/** 分享 token 入口（不携带 id/no）：accessMode='shared'，前端据此隐藏写操作 UI；
		 * 普通登录访问：accessMode='normal'，无 created_by 限制——报表行点击全员可看 */
		const accessMode = (share_token && !id && !no) ? 'shared' : 'normal'
		const rows = await loadItems(order._id)
		// 打样单状态归一（与列表一致）：旧「配货中/待发货/待剪样/已发货」→「已完成」
		if (order.source === 'sample' && (order.status === '配货中' || order.status === '待发货' || order.status === '待剪样' || order.status === '已发货')) {
			order.status = '已完成'
			try {
				await orderCol().doc(order._id).update({ status: '已完成', update_date: Date.now() })
			} catch (e) {
				// 迁移失败仅影响展示，忽略
			}
		}
		return ok({ ...buildOrderView(order, rows), accessMode })
	},

	/* ── 接口：登记出库 / 营业员下单（清单 items 逐款生成明细行，主表 1 条，事务写入） ──
	 * items 两种形态：
	 *   direct（仓管直接出库，登记即扣库存）：
	 *     [{ customer, customerId, name, color, sizes: number[], rollIds: string[], locs: string[] }]
	 *   sales（营业员下单，只记需求、不扣库存）：
	 *     [{ customer, customerId, name, color, demandMeters: number, demandCount: number }]
	 * source 参数：'direct'（默认）/ 'sales'；营业员强制按 sales 处理
	 * delivery/remark：打样单交付方式（market/express）与下单备注（选填），合并写入主表 remark ──
	 */
	async create(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { items = [], source = 'direct', delivery = '', kind = 'out', remark = '' } = params || {}
		if (!Array.isArray(items) || !items.length) return fail('出货清单为空')
		// 营业员只能下 sales/sample 单；仓管/管理员可 direct 或 sales/sample
		const isSales = source === 'sales' || source === 'sample' || isSalesRole(actor.roles)
		// 打样单交付方式：market=带市场，express=快递，self=自取（轻量写入主表 remark 展示）
		const DELIVERY_TEXT = { express: '交付：快递', market: '交付：市场', self: '交付：自取' }
		const deliveryText = source === 'sample' ? (DELIVERY_TEXT[delivery] || '') : ''
		// 下单备注（选填）与交付方式同存 remark：展示端按「交付：X」标记拆分（fmtSampleDelivery / fmtRemarkNote），
		// 快递判定 isSampleExpress 只测 /快递/，合并后不受影响
		const remarkText = [deliveryText, String(remark || '').trim()].filter(Boolean).join(' · ')
		const db = uniCloud.database()
		const now = new Date(Date.now() + 8 * 3600 * 1000) // 云函数默认 UTC+0，转东八区生成日期
		const p = (x) => String(x).padStart(2, '0')
		const date = `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}`
		const time = `${p(now.getUTCHours())}:${p(now.getUTCMinutes())}`
		const ts = Date.now()
		const customer = (items.find((it) => it.customer) || {}).customer || ''

		// 明细文档（不含主表冗余字段）
		const docs = items
			.map((it) => {
				if (isSales) {
					// 营业员单：只写需求字段，配货由仓管在「待配货」状态完成
					const demandMeters = Number(it.demandMeters || it.demand_meters || 0)
					const demandCount = Number(it.demandCount || it.demand_count || 0)
					return {
						name: (it.name || '').trim(),
						color: (it.color || '').trim(),
						demand_meters: demandMeters,
						demand_count: demandCount,
						rolls: [],
						count: 0,
						total_meters: 0,
						roll_ids: [],
						location: '',
						locations: [],
						create_date: ts,
					}
				}
				const rolls = (it.sizes || []).map((v) => Number(v)).filter((v) => v > 0)
				// 与 rolls 一一对应的库位：库存选取部分取卷的库位，手动添加部分为空
				const locs = (it.locs || []).map((v) => String(v || '').trim())
				// 去重后的有效库位（同一款式可能跨多个库位选卷）
				const locations = [...new Set(locs.filter(Boolean))]
				return {
					name: (it.name || '').trim(),
					color: (it.color || '').trim(),
					rolls,
					count: rolls.length,
					total_meters: parseFloat(rolls.reduce((s, v) => s + v, 0).toFixed(1)),
					roll_ids: Array.isArray(it.rollIds) ? it.rollIds : [],
					location: locations[0] || '',
					locations,
					create_date: ts,
				}
			})
			.filter((d) => {
				if (!d.name || !d.color) return false
				if (isSales) return d.demand_meters > 0 || d.demand_count > 0
				return d.rolls.length > 0
			})
		if (!docs.length) {
			return fail(isSales ? '清单数据无效，请检查品名、颜色和需求数量' : '清单数据无效，请检查品名、颜色和细码')
		}

		const no = await nextNo()
		const orderDoc = {
			no,
			customer: customer.trim(),
			customer_id: String((items.find((it) => it.customerId) || {}).customerId || '').trim(),
			operator: actorName(actor.user),
			remark: remarkText,
			status: isSales ? '待配货' : '待确认',
			source: isSales ? source : 'direct',
			/** 出库类型：out=出库 / return=返厂 */
			kind: kind === 'return' ? 'return' : 'out',
			created_by: isSales ? actor.uid : '',
			created_name: isSales ? actorName(actor.user) : '',
			date,
			time,
			count: 0,
			total_meters: 0,
			item_count: 0,
			/** 分享 token：转发链接用（前端 onShareAppMessage 拼 share_token 进入只读视图） */
			share_token: genShareToken(),
			create_date: ts,
			update_date: ts,
		}

		// 直接出库需扣减的库存卷（营业员下单不占库存，roll_ids 为空）
		const deductIds = isSales ? [] : docs.reduce((s, d) => s.concat(d.roll_ids || []), [])
		const uniqRollIds = [...new Set(deductIds)]
		if (!isSales && deductIds.length !== uniqRollIds.length) {
			return fail('清单中存在重复的库存细码，请检查后重新提交')
		}
		// 事务：主表 + 明细 + 库存扣减 原子写入（扣卷逐卷校验「在库」，任一卷已被占用
		// 则整单回滚，前端提示重选后重新提交；杜绝订单建成功而库存未扣/卷被并发占用）
		const transaction = await db.startTransaction()
		try {
			const orderRes = await transaction.collection('order').add(orderDoc)
			const orderId = orderRes.id
			for (const d of docs) {
				await transaction.collection('order_item').add({ ...d, order_id: orderId })
			}
			// 冗余汇总写回主表
			const sum = calcSummary(docs)
			await transaction.collection('order').doc(orderId).update(sum)
			// 扣减库存：逐卷读取校验「在库」后置为已出库
			// （事务内文档级快照 + 提交冲突检测，任一卷被其他单据占用则整单回滚，防超卖）
			const markTs = Date.now()
			for (const rid of uniqRollIds) {
				const res = await transaction.collection('stock_roll').doc(rid).get()
				const roll = Array.isArray(res.data) ? res.data[0] : res.data
				if (!roll || roll.status !== '在库') {
					throw new Error('所选库存细码已被其他单据占用或出库，请刷新后重新选择')
				}
				await transaction.collection('stock_roll').doc(rid).update({
					status: '已出库',
					update_date: markTs,
				})
			}
			await transaction.commit()
			// 事务外副作用：回写客户统计（辅助数据，失败不影响出库账实一致，仅影响档案汇总）
			let touched = 0
			try {
				touched = await touchCustomers(orderDoc.customer_id, date)
			} catch (e) {
				// 客户统计失败忽略
			}
			return ok({ no, id: orderId, share_token: orderDoc.share_token, count: docs.length, deducted: uniqRollIds.length, touched })
		} catch (e) {
			await transaction.rollback().catch(() => {})
			return fail('创建出库单失败：' + (e.message || e))
		}
	},

	/* ── 接口：门店确认（待确认 → 待发货，只改主表；同步最终配货明细） ──
	 * items: [{ name, color, rolls, location, locs }]（详情页编辑后的款式列表）
	 * address/remark：可选，确认「通知发货」时把待确认页已填/自动带出的收货信息草稿一并写入主表，
	 *   避免草稿仅在输入框未入库、流转后丢失（空字符串视为清空，与 update 语义一致）
	 * 仅待确认单可确认；确认后进入待发货，等待发货。
	 * 权限：仓管/管理员可确认；sales/打样待确认单（配货完成后）由下单营业员本人确认并「通知发货」，防止配货方自确认
	 */
	async confirm(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { id, no, items, address, remark } = params || {}
		if (!id && !no) return fail('缺少出库单id或单号')
		const order = await findOrder(id, no)
		if (!order) return fail('出库单不存在')
		if (order.status !== '待确认') return fail('仅待确认状态可确认订单')
		// 营业员（下单操作员）：仅可确认自己创建的 sales/打样单（direct 单无 created_by，营业员本就不可见）
		if (!isStaff(actor.roles) && String(order.created_by || '') !== String(actor.uid)) {
			return fail('无确认权限')
		}
		if (Array.isArray(items) && items.length) {
			await syncItems(order._id, items)
		}
		const patch = { status: '待发货', update_date: Date.now() }
		if (address !== undefined && address !== null) patch.address = String(address).trim()
		if (remark !== undefined && remark !== null) patch.remark = String(remark).trim()
		await orderCol().doc(order._id).update(patch)
		return ok({ id: order._id, no: order.no })
	},

	/* ── 接口：配货（待配货 → 待确认，营业员下单后由仓管完成）
	 * items: [{ name, color, rolls: number[], roll_ids: string[], locs: string[] }]
	 * 将配货卷写入明细（保留原需求字段），并扣减库存；允许部分配货（未配满也可提交）；
	 * 配货完成后流转到「待确认」，由门店确认后进入待发货
	 */
	async allocate(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		if (!isStaff(actor.roles)) return fail('无配货权限')
		const { id, no, items } = params || {}
		if (!id && !no) return fail('缺少出库单id或单号')
		if (!Array.isArray(items) || !items.length) return fail('配货清单为空')
		const order = await findOrder(id, no)
		if (!order) return fail('出库单不存在')
		if (order.status !== '待配货') return fail('仅待配货状态可配货')
		if (order.source === 'sample') return fail('打样订单请使用打样配货')
		const existing = await loadItems(order._id)

		// 事务内完成「库存 diff + 明细写入 + 主表状态流转」：
		// 1) 配货卷 diff：本次新增的卷校验「在库」后扣减、移除的卷归还「在库」、保留的卷不动。
		//    （支持「确认修改保留细码」回到待配货的单：原已配卷已「已出库」，重进配货页增删时只结算差值，
		//     避免重复扣卷 / 被删卷成孤儿）
		// 2) 事务内重读主表校验状态 + 提交冲突检测，防止两人同时配同一单
		const db = uniCloud.database()
		const now = Date.now()
		const transaction = await db.startTransaction()
		try {
			// 防并发双配：事务内重读主表，状态已被其他操作改动则中止（整单回滚）
			const chk = await transaction.collection('order').doc(order._id).get()
			const cur = Array.isArray(chk.data) ? chk.data[0] : chk.data
			if (!cur || cur.status !== '待配货') throw new Error('订单状态已变化，请刷新后重试')

			const used = new Set()
			const matched = []   // 匹配到原需求行的更新 { target, patch }
			const addedDocs = [] // 新增明细文档（含 name/color/order_id）
			/* 开剪与整卷三阶段结算（同一事务）：
			 * 1) 先归还「移除/调剪」的开剪米数（restoreCutDiff，在整卷 diff 前，
			 *    兼容 开剪→整卷：归还米数后卷回在库，再被整卷扣减）；
			 * 2) 整卷 diff（settleRollDiff：新增扣卷 / 移除还卷，兼容 整卷→开剪：
			 *    整卷归还回在库后再被开剪扣米）；
			 * 3) 应用新开剪 / 调剪米数（applyCutDiff），返回 cutInfo 供明细记录落库 */
			const maps = cutMaps(existing, items)
			await restoreCutDiff(transaction, maps, now)
			const { add: deducted, remove: restored } = await settleRollDiff(transaction, existing, items, now)
			const { added: cutAdded, cutInfo } = await applyCutDiff(transaction, maps, now)
			for (const it of items) {
				const name = String(it.name || '').trim()
				const color = String(it.color || '').trim()
				if (!name || !color) throw new Error('存在未填写品名或颜色的款式')
				// 配货字段归一（rolls 前缀与 roll_ids 对齐：整卷在前，开剪/手动细码随后不带卷 id）
				const rolls = (it.rolls || []).map((v) => Number(v)).filter((v) => v > 0)
				const rollIds = [...new Set((it.roll_ids || []).map((v) => String(v || '').trim()).filter(Boolean))]
				if (rollIds.length > rolls.length) {
					throw new Error(`「${name}·${color}」细码数据异常，请重新选择库存卷`)
				}
				const locs = (it.locs || []).map((v) => String(v || '').trim())
				const locations = [...new Set(locs.filter(Boolean))]
				const patch = {
					rolls,
					count: rolls.length,
					total_meters: parseFloat(rolls.reduce((s, v) => s + v, 0).toFixed(1)),
					roll_ids: rollIds,
					location: locations[0] || '',
					locations,
					cuts: cutRecordsFor(it, cutInfo),
					update_date: now,
				}
				// 匹配同品名同颜色的原需求行更新配货字段（保留 demand 字段），否则新增
				const target = existing.find((r) => !used.has(r._id) && rowKey(r) === rowKey(it))
				if (target) {
					used.add(target._id)
					await transaction.collection('order_item').doc(target._id).update(patch)
					matched.push({ target, patch })
				} else {
					const doc = {
						order_id: order._id,
						name,
						color,
						demand_meters: 0,
						demand_count: 0,
						...patch,
						create_date: now,
					}
					const addRes = await transaction.collection('order_item').add(doc)
					addedDocs.push({ ...doc, _id: addRes.id })
				}
			}
			// 未在本次配货中出现的原需求行：其卷/开剪米数已在上方库存 diff 中归还（从云端卷集合移除），
			// 此处剥离历史配货字段（保留需求字段与文档），仅防止残留卷 id 造成展示误导
			for (const r of existing) {
				if (used.has(r._id)) continue
				const hasAllocated = (r.rolls || []).length || (r.roll_ids || []).length || (r.sample_cuts || []).length || (r.cuts || []).length
				if (!hasAllocated) continue
				await transaction.collection('order_item').doc(r._id).update({
					rolls: [],
					roll_ids: [],
					count: 0,
					total_meters: 0,
					location: '',
					locations: [],
					sample_cuts: [],
					cuts: [],
					update_date: now,
				})
			}
			// 重建主表汇总（内存合并：现有明细 + 本次更新/新增）
			const freshRows = existing.map((r) => {
				const hit = matched.find((u) => u.target._id === r._id)
				return hit ? { ...r, ...hit.patch } : r
			})
			for (const d of addedDocs) freshRows.push(d)
			const sum = calcSummary(freshRows)
			await transaction.collection('order').doc(order._id).update({
				...sum,
				status: '待确认',
				update_date: now,
			})
			await transaction.commit()
			// 事务外副作用：配货完成订阅消息通知下单营业员（失败不影响配货结果）
			try {
				await notifyOrderAllocated(order, actorName(actor.user), '已配货')
			} catch (e) {
				// 通知失败忽略
			}
			return ok({ id: order._id, no: order.no, deducted, restored, cutAdded, count: sum.count, total_meters: sum.total_meters })
		} catch (e) {
			await transaction.rollback().catch(() => {})
			return fail('配货失败：' + (e.message || e))
		}
	},

	/* ── 接口：确认发货完成（只改主表，不做其他操作）
	 * 大货/仓管单：待发货 → 已发货；
	 * 打样单：历史兼容（新流程取样配货即已完成，不再产生中间态；残留旧中间态单按已完成收口） ── */
	async ship(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		if (!isStaff(actor.roles)) return fail('无发货权限')
		const { id, no } = params || {}
		if (!id && !no) return fail('缺少出库单id或单号')
		const order = await findOrder(id, no)
		if (!order) return fail('出库单不存在')
		if (order.source === 'sample') {
			if (order.status !== '待剪样' && order.status !== '配货中' && order.status !== '待发货') {
				return fail('仅待剪样状态可确认剪样完成')
			}
			await orderCol().doc(order._id).update({ status: '已完成', update_date: Date.now() })
		} else {
			if (order.status !== '待发货') return fail('仅待发货状态可确认发货')
			await orderCol().doc(order._id).update({ status: '已发货', update_date: Date.now() })
		}
		return ok({ id: order._id, no: order.no })
	},

	/* ── 接口：打样标签打印回执（前端蓝牙打印成功后上报，主表记 label_printed）
	 * 列表页打样单据显示「已打印」标记，区分还没打标签的单；
	 * 幂等：重复打印刷新打印时间；仅打样单可标记；打印本身不涉库存 ── */
	async markLabelPrinted(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { id, no } = params || {}
		if (!id && !no) return fail('缺少出库单id或单号')
		const order = await findOrder(id, no)
		if (!order) return fail('出库单不存在')
		if (order.source !== 'sample') return fail('仅打样单可标记标签打印')
		// 营业员仅可标记自己创建的单（与查看/编辑权限口径一致），仓管/管理员不限
		if (isSalesRole(actor.roles) && String(order.created_by || '') !== String(actor.uid)) {
			return fail('无权标记该订单')
		}
		const now = Date.now()
		await orderCol().doc(order._id).update({ label_printed: true, label_print_time: now, update_date: now })
		return ok({ id: order._id, no: order.no })
	},

	/* ── 接口：门市确认快递信息（历史遗留，仅供旧前端兜底调用）
	 * 旧流程：打样快递单配货后由营业员核对快递面单并确认，方可剪样完成；
	 * 新流程打样单取样配货即「已完成」，不再产生待确认/待剪样中间态，前端不再调用 ── */
	async confirmExpress(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { id, no } = params || {}
		if (!id && !no) return fail('缺少出库单id或单号')
		const order = await findOrder(id, no)
		if (!order) return fail('出库单不存在')
		if (order.source !== 'sample') return fail('该单据不是打样订单')
		if (!isSampleExpress(order)) return fail('非快递交付的打样单无需确认')
		if (order.status !== '待剪样' && order.status !== '配货中') return fail('仅待剪样状态可确认快递信息')
		if (!order.express_image) return fail('仓库尚未上传快递面单图片，暂无法确认')
		if (isSalesRole(actor.roles) && String(order.created_by || '') !== String(actor.uid)) {
			return fail('无权确认该订单')
		}
		await orderCol().doc(order._id).update({
			express_confirmed: true,
			express_confirm_time: Date.now(),
			express_confirm_by: actorName(actor.user),
			update_date: Date.now(),
		})
		return ok({ id: order._id, no: order.no })
	},

	/* ── 接口：开单 / 定价（待确认、待发货可开单与改价；已发货只读不可改）
	 * rows: [{ itemId, unit, price }]，unit：meters=按米计价 / count=按条计价，
	 *   price 为计价单位下的单价（免费行填 0）；
	 * 云端统一计算：计价数量 = 米（total_meters，含需求/配货）/ 条（count 或 rolls.length 或需求条数），
	 * 行金额 amount = 数量 × 单价（2 位小数），整单 total_amount 冗余写主表（含未提交行的历史价）；
	 * 明细冗余 price/unit/amount，供打印/追溯/后续统计。仅开单行为落库，不累加客户档案金额
	 */
	async billing(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { id, no, rows } = params || {}
		if (!id && !no) return fail('缺少出库单id或单号')
		if (!Array.isArray(rows) || !rows.length) return fail('请填写单价后提交')
		const order = await findOrder(id, no)
		if (!order) return fail('出库单不存在')
		if (order.source === 'sample') return fail('打样单无需开单')
		if (order.kind === 'return') return fail('返厂单无需开单')
		if (order.status !== '待确认' && order.status !== '待发货') return fail('仅待确认/待发货可开单，已发货订单价格不可修改')
		// 与 confirm 同口径：sales 单归下单营业员本人，direct 单归仓管
		if (!isStaff(actor.roles) && String(order.created_by || '') !== String(actor.uid)) {
			return fail('无权为该订单开单')
		}
		const items = await loadItems(order._id)
		if (!items.length) return fail('订单明细为空，无法开单')
		const itemMap = {}
		items.forEach((it) => {
			itemMap[String(it._id)] = it
		})
		// 校验提交行存在且价格合法，避免脏数据落库（优先 itemId 精确定位，缺省按品名·颜色兜底）
		const list = []
		for (const r of rows) {
			let it = itemMap[String((r && r.itemId) || '')]
			if (!it) {
				it = items.find(
					(x) => String(x.name || '').trim() === String((r && r.name) || '').trim()
						&& String(x.color || '').trim() === String((r && r.color) || '').trim()
				)
			}
			if (!it) return fail('明细行不存在，请刷新后重试')
			const price = Number(r.price)
			if (!isFinite(price) || price < 0) return fail(`「${it.name}·${it.color}」单价无效`)
			list.push({
				it,
				unit: r.unit === 'count' ? 'count' : 'meters',
				price: Math.round(price * 100) / 100,
			})
		}
		const db = uniCloud.database()
		const now = Date.now()
		const transaction = await db.startTransaction()
		try {
			// 防并发双开：事务内重读主表，状态已被其他操作改动则中止
			const chk = await transaction.collection('order').doc(order._id).get()
			const cur = Array.isArray(chk.data) ? chk.data[0] : chk.data
			if (!cur) throw new Error('订单状态已变化，请刷新后重试')
			const nextItems = items.slice() // 事务内内存汇总（事务内不支持 where 查询）
			let total = 0
			for (const { it, unit, price } of list) {
				const qty = unit === 'meters'
					? rowMeters(it)
					: Number(it.count) || (it.rolls || []).length || Number(it.demand_count) || 0
				const amount = Math.round(qty * price * 100) / 100
				await transaction.collection('order_item').doc(it._id).update({ price, unit, amount, update_date: now })
				const idx = nextItems.findIndex((x) => String(x._id) === String(it._id))
				if (idx >= 0) nextItems[idx] = { ...it, price, unit, amount }
				total += amount
			}
			// 整单合计：本次定价行 + 其余明细保留的历史价（支持分次开单/改价）
			const orderTotal = Math.round(nextItems.reduce((s, x) => s + (Number(x.amount) || 0), 0) * 100) / 100
			await transaction.collection('order').doc(order._id).update({
				total_amount: orderTotal,
				bill_date: now,
				update_date: now,
			})
			await transaction.commit()
			return ok({ id: order._id, no: order.no, total_amount: orderTotal, billed: list.length })
		} catch (e) {
			await transaction.rollback().catch(() => {})
			return fail('开单失败：' + (e.message || e))
		}
	},

	/* ── 接口：打样配货（待配货 → 已完成，仓管在库存细码上扣除打样米数）
	 * 取样即剪样：配货扣库完成即视为该打样单已完成（样品已剪出并交付/寄出），无中间流转；
	 * items: [{ name, color, cuts: [{ rollId, meters }], manual: number[] }]
	 * cuts：选中库存卷，在该卷余量上扣除 meters（扣完即出库）；
	 * manual：无库存时手动录入的取样米数（不扣库存）；
	 * 每款取样明细写入 order_item.sample_cuts，可追溯「哪卷扣了几米、余量多少」
	 */
	async sampleAllocate(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		if (!isStaff(actor.roles)) return fail('无配货权限')
		const { id, no, items } = params || {}
		if (!id && !no) return fail('缺少出库单id或单号')
		if (!Array.isArray(items) || !items.length) return fail('配货清单为空')
		const order = await findOrder(id, no)
		if (!order) return fail('出库单不存在')
		if (order.status !== '待配货') return fail('仅待配货状态可配货')
		if (order.source !== 'sample') return fail('该单据不是打样订单')
		// 快递交付：必须先上传快递面单留档（express_image），方可取样配货完成
		if (isSampleExpress(order) && !order.express_image) return fail('快递交付需先上传快递面单')

		const db = uniCloud.database()
		const now = Date.now()
		const validItems = items.filter((it) => {
			const hasCuts = Array.isArray(it.cuts) && it.cuts.some((c) => Number(c && c.meters) > 0 && String(c.rollId || '').trim())
			const hasManual = (it.manual || []).some((v) => Number(v) > 0)
			return hasCuts || hasManual
		})
		if (!validItems.length) return fail('请至少为一款面料取样配货')

		// 事务内完成「扣卷 + 明细写入 + 主表状态」，保证库存与单据一致
		const transaction = await db.startTransaction()
		try {
			// 防并发双配：事务内重读主表，状态已被其他操作改动则中止（整单回滚）
			const chk = await transaction.collection('order').doc(order._id).get()
			const cur = Array.isArray(chk.data) ? chk.data[0] : chk.data
			if (!cur || cur.status !== '待配货') throw new Error('订单状态已变化，请刷新后重试')
			const existing = await loadItems(order._id)
			/** 本次更新/新增的明细（用于事务外内存汇总，事务内不支持 where 查询） */
			const updatedItems = []
			for (const it of validItems) {
				const name = String(it.name || '').trim()
				const color = String(it.color || '').trim()
				if (!name || !color) throw new Error('存在未填写品名或颜色的款式')
				const rolls = []
				const rollIds = []
				const sampleCuts = []
				const locs = []
				const cutList = (it.cuts || []).filter((c) => Number(c && c.meters) > 0 && String(c.rollId || '').trim())
				for (const c of cutList) {
					const meters = Number(c.meters)
					const rid = String(c.rollId).trim()
					const res = await transaction.collection('stock_roll').doc(rid).get()
					// 事务内 doc().get() 返回 { data: doc }（对象），普通查询返回 { data: [doc] }（数组），
					// 两种结构均需兼容，否则取不到文档会误报「细码已被占用或出库」
					const roll = Array.isArray(res.data) ? res.data[0] : res.data
					if (!roll || roll.status !== '在库') {
						throw new Error(`细码已被占用或出库，请刷新后重新配货（${name}·${color}）`)
					}
					const remain = Number(roll.length) || 0
					if (remain < meters) {
						throw new Error(`「${name}·${color}」所选卷仅余 ${remain} 米，无法取样 ${meters} 米`)
					}
					const next = parseFloat((remain - meters).toFixed(2))
					const patch = { update_date: now }
					if (next <= 0) {
						patch.length = 0
						patch.status = '已出库'
					} else {
						patch.length = next
					}
					await transaction.collection('stock_roll').doc(rid).update(patch)
					rolls.push(meters)
					rollIds.push(rid)
					locs.push(String(roll.location || '').trim())
					sampleCuts.push({
						roll_id: rid,
						location: String(roll.location || ''),
						length: remain,
						cut: meters,
						remain: next > 0 ? next : 0,
					})
				}
				const manual = (it.manual || []).map((v) => Number(v)).filter((v) => v > 0)
				rolls.push(...manual)
				const locations = [...new Set(locs.filter(Boolean))]
				const patchItem = {
					rolls,
					count: rolls.length,
					total_meters: parseFloat(rolls.reduce((s, v) => s + v, 0).toFixed(1)),
					roll_ids: rollIds,
					location: locations[0] || '',
					locations,
					sample_cuts: sampleCuts,
					update_date: now,
				}
				// 匹配同品名同颜色的明细行更新，否则新增
				let target = existing.find(
					(r) => String(r.name || '').trim() === name && String(r.color || '').trim() === color
				)
				updatedItems.push({ key: `${name}|${color}`, patch: patchItem })
				if (target) {
					await transaction.collection('order_item').doc(target._id).update(patchItem)
				} else {
					await transaction.collection('order_item').add({
						order_id: order._id,
						name,
						color,
						...patchItem,
						create_date: now,
					})
				}
			}
			// 重建主表汇总（内存合并：现有明细 + 本次更新/新增，事务内不支持 where 查询）
			const freshRows = existing.map((r) => {
				const hit = updatedItems.find(
					(u) => u.key === `${String(r.name || '').trim()}|${String(r.color || '').trim()}`
				)
				return hit ? { ...r, ...hit.patch } : r
			})
			for (const u of updatedItems) {
				if (!freshRows.some((r) => `${String(r.name || '').trim()}|${String(r.color || '').trim()}` === u.key)) {
					freshRows.push(u.patch)
				}
			}
			const sum = calcSummary(freshRows)
			await transaction.collection('order').doc(order._id).update({
				...sum,
				status: '已完成',
				update_date: now,
			})
			await transaction.commit()
			// 事务外副作用：打样配货完成订阅消息通知下单营业员（失败不影响配货结果）
			try {
				await notifyOrderAllocated(order, actorName(actor.user), '已完成')
			} catch (e) {
				// 通知失败忽略
			}
			return ok({ id: order._id, no: order.no, count: sum.count, total_meters: sum.total_meters })
		} catch (e) {
			await transaction.rollback().catch(() => {})
			return fail('打样配货失败：' + (e.message || e))
		}
	},

	/* ── 接口：打样配货回退（历史遗留，仅供残留旧中间态单兜底）
	 * 旧流程在「待剪样」态回退到待配货；新流程取样配货即「已完成」，配货前由前端弹窗确认，
	 * 已完成单不支持回退；若仍有旧「待剪样/配货中」单，可回退待配货重新配货
	 */
	async unAllocate(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		if (!isStaff(actor.roles)) return fail('无修改权限')
		const { id, no } = params || {}
		if (!id && !no) return fail('缺少出库单id或单号')
		const order = await findOrder(id, no)
		if (!order) return fail('出库单不存在')
		if (order.source !== 'sample') return fail('该单据不是打样订单')
		if (order.status !== '待剪样' && order.status !== '配货中') return fail('仅待剪样状态可修改订单')

		const db = uniCloud.database()
		const now = Date.now()
		const items = await loadItems(order._id)
		/** 需退还的卷：{ rollId, length: 扣前长度, remain: 扣后余量 } */
		const restoreRolls = []
		for (const it of items) {
			for (const c of it.sample_cuts || []) {
				if (!c || !c.roll_id) continue
				restoreRolls.push({
					rollId: String(c.roll_id),
					length: Number(c.length),
					remain: Number(c.remain),
				})
			}
		}

		const transaction = await db.startTransaction()
		try {
			for (const r of restoreRolls) {
				const res = await transaction.collection('stock_roll').doc(r.rollId).get()
				const roll = Array.isArray(res.data) ? res.data[0] : res.data
				if (!roll) continue
				// 卷余量与配货后一致（未被其他单据变动）才允许恢复，否则中止
				if (Number(roll.length) !== r.remain) {
					throw new Error(`细码 ${r.rollId} 余量已被其他单据变动，无法回退，请人工核对库存`)
				}
				await transaction.collection('stock_roll').doc(r.rollId).update({
					length: r.length,
					status: '在库',
					update_date: now,
				})
			}
			// 清空配货明细字段（保留需求字段 demand_meters / demand_count）
			for (const it of items) {
				await transaction.collection('order_item').doc(it._id).update({
					rolls: [],
					roll_ids: [],
					count: 0,
					total_meters: 0,
					location: '',
					locations: [],
					sample_cuts: [],
					update_date: now,
				})
			}
			// 主表回退：状态 → 待配货，配货汇总清零（demand_meters / item_count 保留）；
			// 快递确认一并重置（保留面单图片与收件信息草稿，重新配货后需门市再次确认）
			await transaction.collection('order').doc(order._id).update({
				count: 0,
				total_meters: 0,
				status: '待配货',
				express_confirmed: false,
				express_confirm_time: 0,
				express_confirm_by: '',
				update_date: now,
			})
			await transaction.commit()
			return ok({ id: order._id, no: order.no })
		} catch (e) {
			await transaction.rollback().catch(() => {})
			return fail('修改订单失败：' + (e.message || e))
		}
	},

	/* ── 接口：保存出库单物流信息（面单图片 fileID / 运单号 / 收件人 / 电话 / 收件地址）
	 * 面单图片上传（expressImage，云存储 fileID）仅限仓管/管理员；
	 * 运单号/收件人/电话/地址 营业员与仓管均可填写，门店按面单补全快递单信息。
	 * 打样单与待发货的大货/直接出库单均可用该接口留档物流单
	 */
	async saveExpress(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { id, no, expressImage, expressNo, receiver, receiverPhone, address } = params || {}
		if (!id && !no) return fail('缺少出库单id或单号')
		const order = await findOrder(id, no)
		if (!order) return fail('出库单不存在')
		const patch = {}
		if (expressImage !== undefined && expressImage !== null) {
			if (!isStaff(actor.roles)) return fail('仅仓管可上传快递单图片')
			patch.express_image = String(expressImage).trim()
		}
		if (expressNo !== undefined && expressNo !== null) {
			patch.express_no = String(expressNo).trim()
		}
		if (receiver !== undefined && receiver !== null) {
			patch.receiver = String(receiver).trim()
		}
		if (receiverPhone !== undefined && receiverPhone !== null) {
			patch.receiver_phone = String(receiverPhone).trim()
		}
		if (address !== undefined && address !== null) {
			patch.address = String(address).trim()
		}
		if (!Object.keys(patch).length) return fail('没有需要保存的内容')
		await orderCol().doc(order._id).update({ ...patch, update_date: Date.now() })
		return ok({ id: order._id, no: order.no })
	},

	/* ── 接口：取消订单（待配货 / 待确认）
	 * 营业员仅可取消自己创建的待配货单；仓管/管理员可取消待配货/待确认单；
	 * 已扣减库存的卷（如 direct 待确认单登记时扣库）恢复为「在库」，
	 * 已被其他单据变动的卷跳过恢复，避免覆盖他人扣减；明细保留可追溯
	 */
	async cancel(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { id, no } = params || {}
		if (!id && !no) return fail('缺少出库单id或单号')
		const order = await findOrder(id, no)
		if (!order) return fail('出库单不存在')
		// 权限与状态校验
		if (isSalesRole(actor.roles)) {
			if (order.status !== '待配货') return fail('该订单当前状态不可取消')
			if (String(order.created_by || '') !== String(actor.uid)) return fail('无权取消该订单')
		} else {
			if (order.status !== '待配货' && order.status !== '待确认') return fail('仅待配货或待确认订单可取消')
		}
		// 回退已扣库存（事务化 P0-4）：逐卷放回在库 + 主表置已取消 同一事务原子提交，
		// 杜绝「卷已放回但单未取消 / 单已取消但卷未放回」的半态
		const db = uniCloud.database()
		const rows = await loadItems(order._id)
		const rollIds = rows.reduce((s, d) => s.concat(d.roll_ids || []), [])
		const cutRecords = rows.reduce((s, d) => s.concat(d.cuts || []), [])
		let restored = 0
		const transaction = await db.startTransaction()
		try {
			// 并发复核：事务内重读主表，状态被其他操作改动则中止，避免基于过期状态放卷
			const chk = await transaction.collection('order').doc(order._id).get()
			const cur = Array.isArray(chk.data) ? chk.data[0] : chk.data
			if (!cur || cur.status !== order.status) throw new Error('订单状态已变化，请刷新后重试')
			// 放卷：逐卷复核仍为「已出库」才恢复在库（并发中已被其他单据改动/移走的卷跳过）
			for (const rollId of rollIds) {
				const rchk = await transaction.collection('stock_roll').doc(rollId).get()
				const roll = Array.isArray(rchk.data) ? rchk.data[0] : rchk.data
				if (roll && roll.status === '已出库') {
					await transaction.collection('stock_roll').doc(rollId).update({
						status: '在库',
						update_date: Date.now(),
					})
					restored++
				}
			}
			// 归还开剪米数（打样/大货 cuts）：被其他单据占用的卷跳过，明细保留可追溯
			await restoreCutRecords(transaction, cutRecords, Date.now())
			await transaction.collection('order').doc(order._id).update({
				status: '已取消',
				update_date: Date.now(),
			})
			await transaction.commit()
			// 事务外副作用：取消订单回滚客户订单计数（与 create 时 +1 配对，辅助数据失败不影响取消结果）
			try {
				await adjustCustomerCount(order.customer_id, -1)
			} catch (e) {
				// 客户档案统计回滚失败仅影响详情页「订单数」，忽略
			}
			return ok({ id: order._id, no: order.no, restored })
		} catch (e) {
			await transaction.rollback().catch(() => {})
			return fail('取消出库单失败：' + (e.message || e))
		}
	},

	/* ── 接口：重新开单（已取消 → 待配货）
	 * 在原订单基础上恢复为待配货，可继续编辑需求或配货；
	 * 营业员仅可重新开自己创建的已取消单；仓管/管理员可重新开任何已取消单
	 */
	async reopen(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { id, no } = params || {}
		if (!id && !no) return fail('缺少出库单id或单号')
		const order = await findOrder(id, no)
		if (!order) return fail('出库单不存在')
		if (order.status !== '已取消') return fail('仅已取消订单可重新开单')
		if (isSalesRole(actor.roles) && String(order.created_by || '') !== String(actor.uid)) {
			return fail('无权重新开单')
		}
		await orderCol().doc(order._id).update({ status: '待配货', update_date: Date.now() })
		// 事务外副作用：重新开单恢复客户订单计数（与 cancel -1 配对，辅助数据失败仅影响档案统计）
		try {
			await adjustCustomerCount(order.customer_id, 1)
		} catch (e) {
			// 恢复失败仅影响客户详情页「订单数」，忽略
		}
		return ok({ id: order._id, no: order.no })
	},

	/* ── 接口：保存可编辑出库单的修改
	 * 营业员：仅需求结构编辑（改需求数量/品名颜色、增删未配行），已配行的细码字段以云端为准原样保留——
	 *   营业员不可增删细码；「确认修改」（待确认 → 待配货）只流转状态，已配卷保留在单上，由仓管在配货页增删
	 * 仓管/管理员：待确认（direct）修改可全量同步配货明细（items 携带 rolls/roll_ids 时），
	 *   云端按 diff 结算库存（本次新增的卷扣减、移除的卷归还），卷不会滞留成孤儿；
	 *   待配货单仅编辑需求（items 不带配货字段）时走需求编辑，可整体移除已配行（归还其卷）
	 * address/remark：显式传入时写入主表（空字符串视为清空），用于待确认单补充收货地址与备注
	 * nextStatus：可选状态流转，仅支持「确认修改」将待确认 → 待配货（保留已配细码，进入配货页增补）
	 */
	async update(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { id, no, items, address, remark, nextStatus } = params || {}
		if (!id && !no) return fail('缺少出库单id或单号')
		const order = await findOrder(id, no)
		if (!order) return fail('出库单不存在')
		// 营业员（操作员）仅可编辑自己创建的待配货/待确认单（待确认经确认修改回退待配货）；仓管级可编辑待确认/待配货单；待发货仅允许改收货地址/备注
		if (isSalesRole(actor.roles)) {
			if (order.status !== '待配货' && order.status !== '待确认') return fail('该订单当前状态不可修改')
			if (String(order.created_by || '') !== String(actor.uid)) return fail('无权修改该订单')
		} else {
			if (order.status !== '待确认' && order.status !== '待配货' && order.status !== '待发货') return fail('该订单当前状态不可修改')
		}
		const now = Date.now()
		const hasItems = Array.isArray(items) && items.length

		// 收货地址 / 备注：显式传入才写主表（保留打样单交付方式等原有备注不被误覆盖）
		const patch = {}
		if (address !== undefined && address !== null) patch.address = String(address).trim()
		if (remark !== undefined && remark !== null) patch.remark = String(remark).trim()
		// 确认修改：待确认 → 待配货（营业员本人或仓管级可触发）。已配细码保留在单上不清退，
		// 由仓管进入配货页增删（新需求行需补配、被删的卷在配货页移除时归还库存）
		if (
			nextStatus === '待配货' &&
			order.status === '待确认' &&
			(isStaff(actor.roles) || String(order.created_by || '') === String(actor.uid))
		) {
			patch.status = '待配货'
		}

		if (isSalesRole(actor.roles)) {
			// ── 营业员：仅需求结构编辑，配货字段一律保留云端现有值 ──
			if (hasItems) {
				const existing = await loadItems(order._id)
				// 已配行保护：提交必须原样包含每一已配行（同品名同颜色），营业员不可删除/更换已配款
				const subKeys = new Set(items.map((it) => rowKey(it)))
				for (const r of existing) {
					if (!isAllocRow(r)) continue
					if (!subKeys.has(rowKey(r))) {
						return fail(`「${r.name}·${r.color}」已配货：该款不可删除或更换品名颜色，如需调整请联系仓管`)
					}
				}
				await syncDemandOnly(uniCloud.database(), order._id, existing, items, now)
			}
			if (Object.keys(patch).length) {
				await orderCol().doc(order._id).update({ ...patch, update_date: now })
			}
			return ok({ id: order._id, no: order.no })
		}

		if (order.status !== '待发货' && hasItems) {
			// ── 仓管/管理员：可能触碰库存的编辑一律事务化，杜绝半扣/半态不可自愈 ──
			const existing = await loadItems(order._id)
			// 是否携带卷 id：带 id 的全量配货只应来自配货入口（此路为防御保留，结算库存 diff 后覆盖写入）
			const subHasRollIds = items.some((it) => it && Array.isArray(it.roll_ids) && it.roll_ids.length)
			const db = uniCloud.database()
			const transaction = await db.startTransaction()
			try {
				// 并发复核：事务内重读主表，状态被其他操作改动则中止，避免基于过期状态覆盖写入
				const chk = await transaction.collection('order').doc(order._id).get()
				const cur = Array.isArray(chk.data) ? chk.data[0] : chk.data
				if (!cur || cur.status !== order.status) throw new Error('订单状态已变化，请刷新后重试')
				if (subHasRollIds) {
					// 带卷 id 全量配货：库存 diff（扣/还卷 + 开剪三阶段）与明细覆盖写入同一事务，扣卷失败即整单回滚
					const maps = cutMaps(existing, items)
					await restoreCutDiff(transaction, maps, now)
					await settleRollDiff(transaction, existing, items, now)
					const { cutInfo } = await applyCutDiff(transaction, maps, now)
					// 开剪记录由云端结算结果构建后随明细写入（cutRecords），前端不传原始卷数据
					const withCuts = items.map((it) => ({ ...it, cutRecords: cutRecordsFor(it, cutInfo) }))
					await syncItemsTo(transaction, order._id, existing, withCuts, now)
				} else {
					// detail 修改态：细码以云端为准原样保留（items 不带卷 id），仅同步需求结构与库位；
					// 被整体移除的行：未配行直接删，已配行（仓管整行取消需求）归还其卷后删除（同事务）
					await syncDemandOnly(transaction, order._id, existing, items, now, true)
				}
				// 主表（地址/备注/回退待配货）并入同一事务提交
				if (Object.keys(patch).length) {
					await transaction.collection('order').doc(order._id).update({ ...patch, update_date: now })
				}
				await transaction.commit()
			} catch (e) {
				await transaction.rollback().catch(() => {})
				return fail('保存修改失败：' + (e.message || e))
			}
			return ok({ id: order._id, no: order.no })
		}

		// 待发货（或仅单据字段修改）：只写主表（地址/备注/确认回退），无库存影响
		if (Object.keys(patch).length) {
			await orderCol().doc(order._id).update({ ...patch, update_date: now })
		}
		return ok({ id: order._id, no: order.no })
	},
}
