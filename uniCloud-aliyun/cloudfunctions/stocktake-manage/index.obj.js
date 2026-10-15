'use strict'

/* 库存盘点：库位网格总览 / 单库位盘点 / 保存盘点结果
 * 库位与区来自 location-manage（location_zone / location）
 * 库位内的面料细码来自库存表（stock_roll / fabric / fabric_color）
 * 盘点进度持久化到 stocktake_location（按库位编码幂等 upsert）
 *
 * P0-1 安全改造（2026-09）：
 * 1) 保存盘点结果 = stocktake_location upsert + 库存整组重写（删旧在库细码 → 按结果重建），
 *    全部收敛进同一事务，杜绝「删了一半/删了没建」造成的吞卷与半写；
 * 2) 盘点基线 = 该库位「实时在库账实」+ 账实签名 sign；保存时前端携带 expectSign，
 *    云端事务前校验基线未变，期间库位被出入库/他人盘点改动则拒绝保存，请刷新后重新盘点，
 *    避免用过期页面覆盖他人已发生的库存变动（复活卷）；
 * 3) 事务内对每个待删卷 doc 复核（仍为在库且属本库位）再删，防止并发中已被他单出库/移位的卷被误删。
 */

/* 惰性获取集合引用 */
let _zone = null
let _loc = null
let _roll = null
let _fabric = null
let _color = null
let _stocktake = null
function colZone() {
	if (!_zone) _zone = uniCloud.database().collection('location_zone')
	return _zone
}
function colLoc() {
	if (!_loc) _loc = uniCloud.database().collection('location')
	return _loc
}
function colRoll() {
	if (!_roll) _roll = uniCloud.database().collection('stock_roll')
	return _roll
}
function colFabric() {
	if (!_fabric) _fabric = uniCloud.database().collection('fabric')
	return _fabric
}
function colColor() {
	if (!_color) _color = uniCloud.database().collection('fabric_color')
	return _color
}
function colStocktake() {
	if (!_stocktake) _stocktake = uniCloud.database().collection('stocktake_location')
	return _stocktake
}

/* ── 统一返回结构 / 鉴权：抽到 common/auth-common 公共模块 ── */
const { ok, fail, checkStaff } = require('auth-common')


/* 解析库位编码：A-1-1 → { area:'A', row:1, col:1 }
 * 兼容写法：A1-1（紧凑）、a-1-1（小写）、1-1（无区号，area 留空待按所属区兜底） */
function parseCode(code) {
	const s = (code || '').trim()
	let m = /^([A-Za-z])-(\d+)-(\d+)$/.exec(s)
	if (m) return { area: m[1].toUpperCase(), row: parseInt(m[2], 10), col: parseInt(m[3], 10) }
	m = /^([A-Za-z])(\d+)-(\d+)$/.exec(s)
	if (m) return { area: m[1].toUpperCase(), row: parseInt(m[2], 10), col: parseInt(m[3], 10) }
	m = /^(\d+)-(\d+)$/.exec(s)
	if (m) return { area: '', row: parseInt(m[1], 10), col: parseInt(m[2], 10) }
	return { area: '', row: 0, col: 0 }
}

/* 分页拉取集合下全部匹配记录：云函数单次 get 默认只返回 100 条，库位/在库卷等
 * 数据量可超百，不分页会静默截断、总览格子与计数失真。固定每页 200 循环拼全；
 * orders 形如 [['sort','asc'],['_id','asc']]，跨页排序稳定防漏重 */
async function fetchAll(col, where, fields = [], orders = []) {
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

/* 预取一组在库细码涉及的品名/颜色名称字典，供分组/签名计算复用（避免内部 N+1 查询） */
async function loadDicts(rolls) {
	const db = uniCloud.database()
	const cmd = db.command
	const fabricIds = [...new Set((rolls || []).map((r) => r.fabric_id).filter(Boolean))]
	const colorIds = [...new Set((rolls || []).map((r) => r.color_id).filter(Boolean))]
	const fabricById = {}
	const colorById = {}
	// 品名/颜色字典互不依赖：并发查询，省一次串行往返（保存链路上每个往返都会被细码数量放大）
	const [fRes, cRes] = await Promise.all([
		fabricIds.length ? colFabric().where({ _id: cmd.in(fabricIds) }).field({ _id: true, name: true }).get() : null,
		colorIds.length ? colColor().where({ _id: cmd.in(colorIds) }).field({ _id: true, name: true }).get() : null,
	])
	if (fRes) fRes.data.forEach((x) => { fabricById[x._id] = x.name || '' })
	if (cRes) cRes.data.forEach((x) => { colorById[x._id] = x.name || '' })
	return { fabricById, colorById }
}

/* 库存细码 → 面料分组：按 品名+颜色 聚合，sizes 为各卷匹长
 * dicts 为可选的 loadDicts 结果（批量计算基线/签名时复用，避免多次查询） */
async function rollsToFabrics(rolls, dicts) {
	if (!rolls || !rolls.length) return []
	const { fabricById, colorById } = dicts || (await loadDicts(rolls))
	const map = {}
	const order = []
	rolls.forEach((r) => {
		const name = fabricById[r.fabric_id] || '未知品名'
		const color = colorById[r.color_id] || '未知颜色'
		const key = `${name}::${color}`
		if (!map[key]) {
			map[key] = { name, color, sizes: [] }
			order.push(key)
		}
		map[key].sizes.push(Number(r.length) || 0)
	})
	return order.map((k) => ({
		id: `stk-${k.replace(/[^\w\u4e00-\u9fa5]/g, '')}`,
		name: map[k].name,
		color: map[k].color,
		sizes: map[k].sizes,
		sizeInput: '',
	}))
}

/* 规范化为前端结构：sizes 统一转为 [{ id, value }]，与盘点页模板一致 */
function toFabrics(list) {
	return (list || []).map((f, fi) => ({
		id: f.id || `f-${fi}`,
		name: f.name || '',
		color: f.color || '',
		sizes: (f.sizes || []).map((v, si) => {
			const num = Number(typeof v === 'object' && v !== null ? v.value : v)
			return { id: `s-${fi}-${si}`, value: isNaN(num) ? 0 : num }
		}),
		sizeInput: '',
	}))
}

/* 盘点结果与账面库存归一化比较（仅比对 品名/颜色/匹长，批号差异不视为不一致）。
 * 同款多卡（同品名同颜色）先合并细码，避免同一款式拆成多行导致与库存聚合结果永不一致 */
function normalizeFabrics(list) {
	const map = {}
	const order = []
	;(list || []).forEach((f) => {
		const name = (f.name || '').trim()
		const color = (f.color || '').trim()
		const sizes = (f.sizes || [])
			.map((v) => Number(typeof v === 'object' && v !== null ? v.value : v))
			.filter((v) => v > 0)
		if (!name || !color || !sizes.length) return
		const key = `${name}::${color}`
		if (!map[key]) {
			map[key] = { name, color, sizes: [] }
			order.push(key)
		}
		map[key].sizes.push(...sizes)
	})
	return order
		.map((k) => ({
			name: map[k].name,
			color: map[k].color,
			sizes: map[k].sizes.sort((a, b) => a - b),
		}))
		.sort((a, b) => (a.name + '::' + a.color).localeCompare(b.name + '::' + b.color))
}

/* 事务内单条读取：统一兼容返回对象/数组，文档不存在返回 null */
async function tDocGet(t, coll, id) {
	const res = await t.collection(coll).doc(id).get()
	const d = Array.isArray(res.data) ? res.data[0] : res.data
	return d && d._id ? d : null
}

/* 按盘点结果重建库位库存的事务前只读准备：
 * 查出已存在品名/颜色字典、缺失项待分配编号、本日盘点批号（与原实现一致的生成规则）；
 * 不落任何写操作，写操作统一放事务（rebuildStock）内执行，保证原子 */
async function prepareSync(code, fabrics, ts, needCreate = true) {
	// 盘点结果里没有「账面缺失的匹长」时（只改正匹长或只删多出的卷），
	// 批号、品名/颜色字典、编号全都用不到 → 直接跳过这 4 次查询，省掉整段串行往返
	if (!needCreate) return { fabricMap: {}, colorMap: {}, nextSort: 0, nextColorCode: 0, batchNo: '', ts }
	const db = uniCloud.database()
	const cmd = db.command
	// 批号：PD + 年月日(东八区) + 3 位序号，与入库/出库单号结构一致
	const now = new Date(Date.now() + 8 * 3600 * 1000) // 云函数默认 UTC+0，转东八区生成日期，避免凌晨错位
	const p = (x) => String(x).padStart(2, '0')
	const prefix = `PD${String(now.getUTCFullYear()).slice(-2)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`
	const batchRes = await colRoll().where({ batch_no: new RegExp(`^${prefix}`) }).orderBy('batch_no', 'desc').limit(1).get()
	const lastBatch = (batchRes.data[0] && batchRes.data[0].batch_no) || ''
	const seq = lastBatch ? parseInt(lastBatch.slice(-2), 10) + 1 : 1
	const batchNo = `${prefix}${String(seq).padStart(2, '0')}`

	// 批量预取本库位涉及的品名/颜色字典（一次 in 查询替代循环内 N+1 逐条查询）
	const names = [...new Set((fabrics || []).map((f) => String((f.name || '').trim())).filter(Boolean))]
	const colors = [...new Set((fabrics || []).map((f) => String((f.color || '').trim())).filter(Boolean))]
	const fabricMap = {} // name -> { _id, color_ids }（缺失项 _id 置空待事务内建档）
	const colorMap = {} // name -> { _id }（缺失项 _id 置空待事务内建档）
	if (names.length) {
		const fRes = await db.collection('fabric')
			.where({ name: cmd.in(names) })
			.field({ _id: true, name: true, color_ids: true })
			.get()
		fRes.data.forEach((x) => { fabricMap[x.name] = { _id: x._id, color_ids: x.color_ids || [] } })
	}
	if (colors.length) {
		const cRes = await db.collection('fabric_color')
			.where({ name: cmd.in(colors) })
			.field({ _id: true, name: true })
			.get()
		cRes.data.forEach((x) => { colorMap[x.name] = { _id: x._id } })
	}
	// 缺失品名/颜色的编号分配：一次取当前最大值，随后事务内自增（与入库 confirm 一致）
	let nextSort = 0
	let nextColorCode = 0
	if (names.some((n) => !fabricMap[n])) {
		const maxRes = await db.collection('fabric').orderBy('sort', 'desc').limit(1).get()
		nextSort = ((maxRes.data[0] && maxRes.data[0].sort) || 0) + 1
	}
	if (colors.some((c) => !colorMap[c])) {
		const maxRes = await db.collection('fabric_color')
			.orderBy('color_code', 'desc')
			.limit(1)
			.get()
		nextColorCode = (maxRes.data[0] && parseInt(maxRes.data[0].color_code, 10)) || 0
	}
	return { fabricMap, colorMap, nextSort, nextColorCode, batchNo, ts }
}

/* 盘点结果与账实逐卷对比，产出「卷级最小差异」库存改写计划 ops：
 *  - { kind: 'delete', rollIds }：账面多出的卷 → 事务内按 id 删除
 *  - { kind: 'update', items: [{ id, length }] }：匹长记错的在库卷 → 原地改正匹长
 *  - { kind: 'sync', name, color, sizes }：账面缺失的匹长 → 新建卷入账
 * 匹长相同的卷原地保留、零写操作：修好一卷只需 1 次写（旧实现按款整组删建，一款 N 卷即 2N 次写），
 * 且保留卷的批号/入库来源不被改写，盘点不会破坏入库追溯链 */
function planSyncOps(currentRolls, dicts, fabrics) {
	const { fabricById, colorById } = dicts
	const key = (name, color) => `${name}::${color}`

	// 账实分组：同品名同颜色的在库卷（key 双方同用 trim，口径一致）
	const grp = new Map()
	for (const r of currentRolls || []) {
		const name = ((fabricById[r.fabric_id] || '') + '').trim()
		const color = ((colorById[r.color_id] || '') + '').trim()
		const k = key(name, color)
		if (!grp.has(k)) grp.set(k, { name, color, rolls: [] })
		grp.get(k).rolls.push(r)
	}

	// 盘点目标分组：同款同色多卡先合并 sizes（与 normalizeFabrics 口径一致）
	const tar = new Map()
	for (const f of fabrics || []) {
		const name = (f.name || '').trim()
		const color = (f.color || '').trim()
		const sizes = (f.sizes || []).map((v) => Number(v)).filter((v) => v > 0).sort((a, b) => a - b)
		if (!name || !color || !sizes.length) continue
		const k = key(name, color)
		if (!tar.has(k)) tar.set(k, { name, color, sizes: [] })
		tar.get(k).sizes.push(...sizes)
	}
	tar.forEach((t) => { t.sizes.sort((a, b) => a - b) })

	const delIds = []
	const updates = []
	const syncs = []
	// 逐款比对（账实与目标的款名并集）：账实独有的款 → 卷全多出；目标独有的款 → 匹长全缺失
	const keys = new Set([...grp.keys(), ...tar.keys()])
	for (const k of keys) {
		const g = grp.get(k)
		const t = tar.get(k)
		const sizes = t ? t.sizes.slice() : []
		// 账实卷按匹长归堆：目标匹长逐个「认领」同匹长的一卷 → 被认领的卷原地保留（连批号一起留）
		const pool = new Map()
		for (const r of g ? g.rolls : []) {
			const v = Number(r.length) || 0
			if (!pool.has(v)) pool.set(v, [])
			pool.get(v).push(r)
		}
		const left = []
		for (const s of sizes) {
			const p = pool.get(s)
			if (p && p.length) p.shift()
			else left.push(s)
		}
		// 剩下的账实卷优先「原地改正匹长」去补缺失的匹长（1 次写换 1 卷），补不上的才删；还缺的匹长才新建
		const rest = []
		pool.forEach((p) => rest.push(...p))
		const n = Math.min(rest.length, left.length)
		for (let i = 0; i < n; i++) {
			if (rest[i]._id) updates.push({ id: rest[i]._id, length: left[i] })
		}
		for (let i = n; i < rest.length; i++) {
			if (rest[i]._id) delIds.push(rest[i]._id)
		}
		if (left.length > n) syncs.push({ name: t.name, color: t.color, sizes: left.slice(n) })
	}
	const ops = []
	if (delIds.length) ops.push({ kind: 'delete', rollIds: delIds })
	if (updates.length) ops.push({ kind: 'update', items: updates })
	for (const s of syncs) ops.push({ kind: 'sync', name: s.name, color: s.color, sizes: s.sizes })
	return ops
}

/* 事务外批量复核「待改写卷」（待删 + 待改正匹长）：一次 in 查询（按 100 分块）替代事务内逐卷 doc 复核。
 * 只保留仍属本库位且在库的卷 id，语义与事务内逐卷复核一致，但把 N 次读往返收敛为 1~2 次，
 * 细码多时事务内往返直接从 2N 降到 N（保存耗时约减半）。
 * 复核后到事务提交之间的并发改动，仍由事务写冲突检测兜底：冲突即整组回滚，绝不会误删/误改他人占用的卷 */
async function verifyWritableRolls(delIds, code) {
	const valid = new Set()
	if (!delIds || !delIds.length) return valid
	const cmd = uniCloud.database().command
	const CHUNK = 100 // in 参数保守分块，避免单次查询参数过多
	for (let i = 0; i < delIds.length; i += CHUNK) {
		const part = delIds.slice(i, i + CHUNK)
		const res = await colRoll()
			.where({ _id: cmd.in(part), location: code, status: '在库' })
			.field({ _id: true })
			.get()
		;(res.data || []).forEach((x) => valid.add(x._id))
	}
	return valid
}

/* 事务内按「卷级最小差异」计划改写库位库存（操作量 = 实际有差异的卷数，而非整款卷数）：
 * 1) delete：账面多出的卷 → 删除（并发中已被他单出库/移位的卷跳过，防误删他人占用）；
 * 2) update：匹长记错的卷 → 原地改正 length（保留卷身份、批号、入库来源）；
 * 3) sync：账面缺失的匹长 → 逐卷入账，品名/颜色缺失时在事务内自动建档到 fabric / fabric_color，
 *    未关联颜色追加 color_ids，每卷以盘点批号入账 stock_roll。
 * 全程使用事务对象，任一步失败由调用方 rollback 整组回滚，不留半写状态。
 * 返回 { deleted, updated } 供调用方回写盘点后的库位卷数 */
async function applySyncOps(t, code, ops, prep, writableIds) {
	const { fabricMap, colorMap, batchNo } = prep
	let { nextSort, nextColorCode } = prep
	const ts = prep.ts || Date.now()
	let deleted = 0
	let updated = 0
	for (const op of ops || []) {
		if (op.kind !== 'delete') continue
		for (const id of op.rollIds) {
			// 「仍属本库位且在库」已由事务外批量复核（verifyWritableRolls）给出，
			// 事务内不再逐卷 doc 复核：细码多时往返从每卷 2 次降到 1 次
			if (!writableIds || !writableIds.has(id)) continue
			await t.collection('stock_roll').doc(id).remove()
			deleted++
		}
	}
	for (const op of ops || []) {
		if (op.kind !== 'update') continue
		for (const it of op.items || []) {
			// 该卷已被他单出库/移走则跳过（复核同删除口径），不动其长度，避免覆盖他人账实
			if (!writableIds || !writableIds.has(it.id)) continue
			// 只改匹长与更新时间：实物仍是那一卷，批号/入库单号保持原样（入库追溯链不断）
			await t.collection('stock_roll').doc(it.id).update({ length: Number(it.length) || 0, update_date: ts })
			updated++
		}
	}
	for (const op of ops || []) {
		if (op.kind !== 'sync') continue
		const { name, color, sizes } = op
		// 品名：命中字典直接复用，缺失则建档（同款多次出现不重复建）
		let fab = fabricMap[name]
		if (!fab) {
			const addRes = await t.collection('fabric').add({
				name,
				sort: nextSort,
				create_date: ts,
				update_date: ts,
			})
			nextSort++
			fab = { _id: addRes.id, color_ids: [] }
			fabricMap[name] = fab
		}
		// 颜色：命中字典直接复用，缺失则建档
		let colorDoc = colorMap[color]
		if (!colorDoc) {
			const addRes = await t.collection('fabric_color').add({
				name: color,
				color_code: String(nextColorCode + 1).padStart(2, '0'),
				create_date: ts,
				update_date: ts,
			})
			nextColorCode++
			colorDoc = { _id: addRes.id, name: color }
			colorMap[color] = colorDoc
		}
		// 关联到品名（品名已存在且未关联该颜色时追加 color_ids）
		const ids = fab.color_ids || []
		if (!ids.includes(colorDoc._id)) {
			await t.collection('fabric').doc(fab._id).update({ color_ids: [...ids, colorDoc._id], update_date: ts })
			fab.color_ids = [...ids, colorDoc._id]
		}
		for (const length of sizes) {
			await t.collection('stock_roll').add({
				fabric_id: fab._id,
				color_id: colorDoc._id,
				length: Number(length),
				location: code,
				batch_no: batchNo,
				inbound_no: '',
				status: '在库',
				create_date: ts,
				update_date: ts,
			})
		}
	}
	return { deleted, updated }
}

module.exports = {
	/* ── 接口：盘点总览（区 → 库位 → 实时在库卷数）
	 * 页面仅展示库位存放三态，不再区分盘点状态：盘点保存时已把该库位库存整组重写为盘点结果，
	 * 因此以「在库账实卷数」作为库位当前存放数即可（盘点前=账面卷数，盘点后=盘点结果，口径一致） ── */
	async overview() {
		// 区/库位/在库卷均可能超过单次 get 的 100 条上限，统一分页拉全，避免截断导致格子缺失/计数偏小
		const zoneRes = await fetchAll(colZone(), {}, ['name', 'sort'], [['sort', 'asc'], ['_id', 'asc']])
		const locRes = await fetchAll(colLoc(), {}, ['zone_id', 'code'])
		if (!zoneRes.length) return ok({ zones: [] })

		// 实时在库卷数：聚合下推到数据库端按库位分组（只传回「库位 → 卷数」的小结果），
		// 替代旧实现「全量在库卷逐页(200/页)拉回云函数内存再计数」——2 万卷时旧实现约 100 次串行查询。
		// 分页用 location 游标而非 skip：skip 会让第 2、3 页把同一个全表聚合结果重算一遍
		// （600 库位约 3 页 = 全表扫 3 次）；游标在 location 建索引时直接走区间扫描，
		// 无索引时也不劣于 skip。分组前 match(location > last) 与分组后 _id 升序口径一致
		// （同为字符串比较），不会漏组或重组；null 分组（无库位的卷）排在首位，必落在第 1 页。
		const dbCmd = uniCloud.database().command
		const aggCmd = dbCmd.aggregate
		const countByLoc = {}
		let last = ''
		for (;;) {
			const where = { status: '在库' }
			if (last) where.location = dbCmd.gt(last)
			const page = await colRoll()
				.aggregate()
				.match(where)
				.group({ _id: '$location', count: aggCmd.sum(1) })
				.sort({ _id: 1 })
				.limit(200)
				.end()
			const rows = (page && page.data) || []
			rows.forEach((g) => {
				const k = g._id || ''
				if (k) countByLoc[k] = (countByLoc[k] || 0) + g.count
			})
			if (rows.length < 200) break
			// 游标推进：分组 _id 为空时无法继续，退出避免死循环
			last = String(rows[rows.length - 1]._id || '')
			if (!last) break
		}

		const zones = zoneRes.map((z) => {
			const name = (z.name || '').replace(/区$/, '')
			const locations = locRes
				.filter((l) => l.zone_id === z._id)
				.map((l) => {
					const code = l.code || ''
					const { row, col } = parseCode(code)
					return { id: l._id, code, row, col, count: countByLoc[code] || 0 }
				})
				.sort((a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col))
			return { id: z._id, name, locations }
		})
		return ok({ zones })
	},

	/* ── 接口：单库位盘点数据
	 * 基线 = 该库位「实时在库账实」（无论此前是否盘过，账面即最新账实；盘点记录仅提供状态展示），
	 * 并返回账实签名 sign：保存盘点结果时原样携带，云端据此识别编辑期间库存是否已被其他单据变动 ── */
	async getLocation(params) {
		const { code } = params || {}
		if (!code) return fail('缺少库位编码')
		let { area, row, col } = parseCode(code)
		// 编码未带区号（如 1-10）时，按库位记录所属库区兜底区号
		if (!area) {
			const locRes = await colLoc().where({ code }).limit(1).get()
			const loc = locRes.data[0]
			if (loc && loc.zone_id) {
				const zRes = await colZone().where({ _id: loc.zone_id }).limit(1).get()
				const z = zRes.data[0]
				if (z && z.name) area = (z.name || '').replace(/区$/, '')
			}
		}

		const stRes = await colStocktake().where({ code }).limit(1).get()
		const saved = stRes.data[0]

		// 实时账实基线 + 签名：分页拉全，单次 get 默认最多 100 条，细码超百会被静默截断（页面少显示卷）
		const currentRolls = await fetchAll(colRoll(), { location: code, status: '在库' }, [], [['_id', 'asc']])
		const dicts = await loadDicts(currentRolls)
		const base = await rollsToFabrics(currentRolls, dicts)
		const sign = JSON.stringify(normalizeFabrics(base))

		return ok({
			code,
			area,
			row,
			col,
			capacity: 0,
			status: saved ? saved.status || 'pending' : 'pending',
			fabrics: toFabrics(base),
			sign,
		})
	},

	/* ── 接口：保存盘点结果
	 * 事务内原子完成：stocktake_location 幂等 upsert + 库位库存按「卷级最小差异」改写
	 * （同匹长的卷原地保留，只改正匹长 / 删多出的卷 / 建缺失的卷；品名/颜色缺失自动建档），
	 * 任一步失败整组回滚，杜绝吞卷/半写；编辑期间库位账实被其他单据改动（expectSign 不匹配）则拒绝保存 ── */
	async save(params) {
		const denied = await checkStaff(this)
		if (denied) return denied
		const { code, status, fabrics, expectSign } = params || {}
		if (!code) return fail('缺少库位编码')
		const now = Date.now()
		// 盘点记录收敛为「实际入账」口径：仅保留 名称/颜色齐备且至少一卷 的款，
		// 未选品名/颜色的临时卡不写入记录、不参与差异改写（与 planSyncOps 入账规则一致），
		// 避免前端按卡统计条数时把这类卷计入、与云端真实在库数不一致
		const recFabrics = Array.isArray(fabrics)
			? fabrics
					.map((f) => ({
						name: (f.name || '').trim(),
						color: (f.color || '').trim(),
						sizes: (f.sizes || []).map((v) => Number(v)).filter((v) => v > 0),
					}))
					.filter((f) => f.name && f.color && f.sizes.length)
			: []
		const doc = {
			code,
			status: status === 'partial' ? 'partial' : recFabrics.length ? 'done' : 'pending',
			fabrics: recFabrics,
			update_date: now,
		}

		// ── 事务外只读准备：现有盘点记录（upsert 定位）、库位实时在库卷、账实签名 ──
		// 两者互不依赖，并发执行；在库卷分页拉全（单次 get 默认上限 100 条，细码超百会被静默截断）
		const [stRes, currentRolls] = await Promise.all([
			colStocktake().where({ code }).limit(1).get(),
			fetchAll(colRoll(), { location: code, status: '在库' }, [], [['_id', 'asc']]),
		])
		const stRec = stRes.data[0]
		const dicts = await loadDicts(currentRolls)
		const base = await rollsToFabrics(currentRolls, dicts)
		const nowSign = JSON.stringify(normalizeFabrics(base))

		// 乐观并发检测：前端基线签名与当前账实不一致 → 期间库存已被其他单据变动，拒绝覆盖
		if (expectSign && expectSign !== nowSign) {
			return fail('盘点期间该库位库存已被其他单据变动，请刷新后重新盘点')
		}

		// 盘点结果与账面逐卷对比，产出「卷级最小差异」改写计划：
		// 匹长相同的卷原地保留（零操作），只有匹长对不上/数量不齐的卷才进事务改正、删除或新建
		const ops = planSyncOps(currentRolls, dicts, doc.fabrics)
		const needSync = ops.length > 0
		// 需改写库存时，先事务外完成两件互不依赖的准备工作，并发执行省一次串行往返：
		//   1) 建档规划（无缺失匹长要新建时整段跳过：批号/品名字典查询都用不到）
		//   2) 待改写卷（待删 + 待改正匹长）批量复核，供事务内直接按 id 写
		const needCreate = ops.some((o) => o.kind === 'sync')
		const writableIds = needSync
			? [
					...new Set(
						ops
							.flatMap((o) => (o.kind === 'delete' ? o.rollIds : o.kind === 'update' ? o.items.map((x) => x.id) : []))
							.filter(Boolean)
					),
				]
			: []
		const [prep, validIds] = needSync
			? await Promise.all([prepareSync(code, doc.fabrics, now, needCreate), verifyWritableRolls(writableIds, code)])
			: [null, new Set()]

		// ── 事务：盘点记录 upsert + 库存卷级差异改写 原子提交 ──
		const transaction = await uniCloud.database().startTransaction()
		try {
			if (stRec) {
				// 幂等 upsert：先按已知 _id 事务内复核，防并发删除/已不存在
				const cur = await tDocGet(transaction, 'stocktake_location', stRec._id)
				if (cur) {
					await transaction.collection('stocktake_location').doc(stRec._id).update(doc)
				} else {
					await transaction.collection('stocktake_location').add({ ...doc, create_date: now })
				}
			} else {
				await transaction.collection('stocktake_location').add({ ...doc, create_date: now })
			}
			// 差异改写实际删除/改正/新建卷数（复核未通过被跳过的卷不计入）
			let deleted = 0
			let added = 0
			let updated = 0
			if (needSync) {
				const res = await applySyncOps(transaction, code, ops, prep, validIds)
				deleted = res.deleted
				updated = res.updated
				ops.forEach((o) => {
					if (o.kind === 'sync') added += (o.sizes || []).length
				})
			}
			await transaction.commit()
			// 返回盘后该库位实际在库卷数（盘点前在库 − 已删 + 已建；改正匹长不改变卷数），
			// 供总览格子按此回写：网格数字与盘点保存结果始终同源，不再依赖前端自算
			const finalCount = currentRolls.length - deleted + added
			return ok({ code, status: doc.status, synced: needSync, count: finalCount, deleted, added, updated })
		} catch (e) {
			await transaction.rollback().catch(() => {})
			return fail('保存盘点失败：' + (e.message || e))
		}
	},
}
