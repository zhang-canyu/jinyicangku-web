'use strict'

/* 惰性获取集合引用 */
let _fabric = null
let _color = null
let _roll = null
let _zone = null
let _loc = null
function colFabric() {
	if (!_fabric) _fabric = uniCloud.database().collection('fabric')
	return _fabric
}
function colColor() {
	if (!_color) _color = uniCloud.database().collection('fabric_color')
	return _color
}
function colRoll() {
	if (!_roll) _roll = uniCloud.database().collection('stock_roll')
	return _roll
}
function colZone() {
	if (!_zone) _zone = uniCloud.database().collection('location_zone')
	return _zone
}
function colLoc() {
	if (!_loc) _loc = uniCloud.database().collection('location')
	return _loc
}

/* 库位补全区位：已带区号（如 A5-10）原样返回；无区号（如 5-10）按库位字典补成 A5-10 */
function withZone(code, zoneByCode) {
	if (/^[A-Za-z]/.test(code)) return code
	const zone = zoneByCode[code]
	return zone ? `${zone}${code}` : code
}

/* ── 统一返回结构：{ code, message, data }，与现有前端封装一致 ── */
function ok(data) {
	return { code: 0, message: 'ok', data }
}
function fail(message, code = -1) {
	return { code, message }
}

/* 查询所有被开剪（打样取样 / 大货配货开剪）过的细码卷 id 集合
 * （order_item.sample_cuts.roll_id 与 order_item.cuts.roll_id）
 * 分页拉取避免默认单次 100 条上限导致标记不全。
 * 模块级缓存：list()/getStockRolls() 每次调用都全表分页扫 order_item，成本高且
 * cut 标记仅影响展示——warm 实例内 60 秒复用，开剪落库后最迟 1 分钟可见；
 * 冷启动自然重建，无需失效钩子（若有强制刷新诉求再给调用方加 force 参数） */
let _cutIdsCache = null
let _cutIdsAt = 0
const CUT_IDS_TTL = 60 * 1000

async function fetchCutRollIds() {
	if (_cutIdsCache && Date.now() - _cutIdsAt < CUT_IDS_TTL) return _cutIdsCache
	const db = uniCloud.database()
	const cmd = db.command
	const ids = new Set()
	let offset = 0
	const pageSize = 500
	for (;;) {
		const res = await db
			.collection('order_item')
			.where(cmd.or([{ sample_cuts: cmd.exists(true) }, { cuts: cmd.exists(true) }]))
			.field({ sample_cuts: true, cuts: true })
			.skip(offset)
			.limit(pageSize)
			.get()
		res.data.forEach((it) => {
			;(it.sample_cuts || []).forEach((c) => {
				if (c && c.roll_id) ids.add(String(c.roll_id))
			})
			;(it.cuts || []).forEach((c) => {
				if (c && c.roll_id) ids.add(String(c.roll_id))
			})
		})
		if (res.data.length < pageSize) break
		offset += pageSize
	}
	_cutIdsCache = ids
	_cutIdsAt = Date.now()
	return ids
}

/* 分页拉取集合下全部匹配记录：云函数单次 get 默认只返回 100 条（上限 1000），
 * 库存卷、色卡、品名等数据量可超百，不分页会静默截断、库存树与余量失真。
 * 每页 500 条循环拼全（页大往返少，页小内存省，500 为折中）；orders 形如
 * [['sort','asc'],['_id','asc']]，跨页排序稳定防漏重 */
async function fetchAll(col, where, fields = [], orders = []) {
	const out = []
	const pageSize = 500
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

/* 细码按批号 → 库位 分组，返回 BatchEntry[]（库位自动补全区位） */
function groupRolls(rolls, zoneByCode, cutIds) {
	const batchMap = {}
	rolls.forEach((r) => {
		const bn = r.batch_no || '未知批号'
		if (!batchMap[bn]) batchMap[bn] = {}
		const raw = (r.location || '').trim() || '未上架'
		const loc = raw === '未上架' ? raw : withZone(raw, zoneByCode)
		if (!batchMap[bn][loc]) batchMap[bn][loc] = []
		batchMap[bn][loc].push({ id: r._id, length: r.length, cut: !!(cutIds && cutIds.has(r._id)) })
	})
	return Object.keys(batchMap)
		.sort()
		.map((bn) => ({
			batchNo: bn,
			locations: Object.keys(batchMap[bn])
				.sort()
				.map((loc) => ({ locationCode: loc, rolls: batchMap[bn][loc] })),
		}))
}

module.exports = {
	/* ── 接口：库存总览（品名 → 颜色 → 批号 → 库位 → 细码 树） ── */
	async list() {
		/* 阶段1（四路并行，互不依赖）：
		 * 库位/区位字典、品名、开剪卷 id（扫 order_item，最慢的一步提前并行，
		 * 总耗时从「6 步串行相加」降为「max(阶段1) + max(阶段2)」） */
		const [zoneRows, locRows, fabrics, cutIds] = await Promise.all([
			fetchAll(colZone(), {}, ['_id', 'name'], [['sort', 'asc'], ['_id', 'asc']]),
			fetchAll(colLoc(), {}, ['code', 'zone_id'], [['_id', 'asc']]),
			fetchAll(colFabric(), {}, ['name', 'color_ids'], [['sort', 'asc'], ['_id', 'asc']]),
			fetchCutRollIds(),
		])
		// 库位字典：code → 区名（去掉「区」后缀），用于给库存中无区号的库位补全区位
		const zoneNameById = {}
		zoneRows.forEach((z) => {
			zoneNameById[z._id] = (z.name || '').replace(/区$/, '')
		})
		const zoneByCode = {}
		locRows.forEach((l) => {
			const code = (l.code || '').trim()
			const zone = zoneNameById[l.zone_id] || ''
			if (code && zone) zoneByCode[code] = zone
		})
		if (!fabrics.length) return ok({ list: [] })
		const cmd = uniCloud.database().command
		const colorIds = [...new Set(fabrics.reduce((s, f) => s.concat(f.color_ids || []), []))]
		/* 阶段2（两路并行，均只依赖 fabrics 的 color_ids）：
		 * 色卡名称 + 在库卷 */
		const [colors, rolls] = await Promise.all([
			colorIds.length
				? fetchAll(colColor(), { _id: cmd.in(colorIds) }, ['_id', 'name'], [['_id', 'asc']])
				: Promise.resolve([]),
			fetchAll(
				colRoll(),
				{ color_id: cmd.in(colorIds), status: '在库' },
				['_id', 'fabric_id', 'color_id', 'length', 'location', 'batch_no']
			),
		])
		const colorById = {}
		colors.forEach((c) => { colorById[c._id] = c })

		/* 颜色为全局共享：同一颜色可同时挂在多个品名下，
		 * 卷必须按 品名+颜色 双维度归组，否则同色卷会在每个引用它的品名下重复展示 */
		const rollByFabColor = {}
		rolls.forEach((r) => {
			const key = `${r.fabric_id || ''}::${r.color_id}`
			;(rollByFabColor[key] = rollByFabColor[key] || []).push(r)
		})

		const list = fabrics.map((f) => ({
			name: f.name,
			colors: (f.color_ids || []).map((id) => colorById[id]).filter(Boolean).map((c) => ({
				color: c.name,
				batches: groupRolls(rollByFabColor[`${f._id}::${c._id}`] || [], zoneByCode, cutIds),
			})),
		}))
		return ok({ list })
	},

	/* ── 接口：按品名+颜色查在库库存细码（出库登记用，免登录校验） ── */
	async getStockRolls(params) {
		const { name = '', color = '' } = params || {}
		const n = String(name).trim()
		const c = String(color).trim()
		if (!n || !c) return ok({ list: [] })
		const fabRes = await colFabric().where({ name: n }).limit(1).get()
		if (!fabRes.data.length) return ok({ list: [] })
		const colorIds = fabRes.data[0].color_ids || []
		if (!colorIds.length) return ok({ list: [] })
		const colorRes = await colColor().where({ _id: uniCloud.database().command.in(colorIds), name: c }).limit(1).get()
		if (!colorRes.data.length) return ok({ list: [] })
		// 同色可挂多个品名：必须同时限定 fabric_id，避免列出其他品名下的同色卷
		const rolls = await fetchAll(
			colRoll(),
			{ fabric_id: fabRes.data[0]._id, color_id: colorRes.data[0]._id, status: '在库' },
			['_id', 'length', 'location', 'batch_no'],
			[['location', 'asc'], ['_id', 'asc']]
		)
		const cutIds = await fetchCutRollIds()
		return ok({
			list: rolls.map((r) => ({
				id: r._id,
				length: Number(r.length),
				location: (r.location || '').trim() || '未上架',
				batchNo: r.batch_no || '',
				cut: cutIds.has(r._id),
			})),
		})
	},
}
