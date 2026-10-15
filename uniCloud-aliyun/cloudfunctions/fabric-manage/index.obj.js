'use strict'

/* ── 临时调试日志（定位「颜色加载卡住 / 颜色不全」）──
 * 排查完成后把 DEBUG 改为 false 即可静音；也可搜索 [fabric-debug] 整段删除 */
const DEBUG = true
function dlog(...args) {
	if (DEBUG) console.log('[fabric-debug]', ...args)
}

/* 惰性获取集合引用 */
let _fab = null
let _color = null
function colFab() {
	if (!_fab) _fab = uniCloud.database().collection('fabric')
	return _fab
}
function colColor() {
	if (!_color) _color = uniCloud.database().collection('fabric_color')
	return _color
}

/* ── 统一返回结构 / 鉴权：抽到 common/auth-common 公共模块 ── */
const { ok, fail, getActor, checkAdmin, checkEditor } = require('auth-common')

/* ═══════════ 权限模型（产品档案，与 customer-manage 同构） ═══════════
 * 管理员(admin)     ：增/改/删 全部操作
 * 营业员(salesperson)：可维护品名与颜色（含历史 sales 归一），删除等破坏性操作除外
 * 仓管(warehouse)   ：只读（可查看/搜索）
 * 任意登录用户      ：可读取
 * ═══════════════════════════════════════════════════════════════════ */


module.exports = {
	/* ── 接口：品名+颜色树（产品管理页，登录角色可读）
	 * 品名可上百、全局颜色可达数千，两者都做分页循环聚合：
	 * 云函数端 get 未设 limit 默认只返回 100 条，一次性拉全会被截断丢数据 ── */
	async list(params) {
		const actor = await getActor(this)
		if (actor.fail) return actor.fail
		const { keyword = '' } = params || {}
		const cmd = uniCloud.database().command
		// 1. 分页拉全品名（每批 ≤1000）
		const FAB_BATCH = 1000
		const fabrics = []
		let offset = 0
		for (;;) {
			const fabRes = await colFab()
				.orderBy('sort', 'asc')
				.field({ name: true, color_ids: true, code: true, width: true, weight: true })
				.skip(offset)
				.limit(FAB_BATCH)
				.get()
			fabrics.push(...fabRes.data)
			if (fabRes.data.length < FAB_BATCH) break
			offset += FAB_BATCH
		}
		// 2. 汇总被引用的颜色 id，分批 in 拉取名称（防止单次 in 查询只回 100 条导致颜色缺失；
		//    各批次相互独立，Promise.all 并发拉取，颜色上千时也不会线性变慢）
		const colorIds = [...new Set(fabrics.reduce((s, f) => s.concat(f.color_ids || []), []))]
		const colorById = {}
		const COLOR_BATCH = 500
		const chunks = []
		for (let i = 0; i < colorIds.length; i += COLOR_BATCH) {
			chunks.push(
				colColor()
					.where({ _id: cmd.in(colorIds.slice(i, i + COLOR_BATCH)) })
					.field({ name: true })
					.limit(COLOR_BATCH)
					.get()
			)
		}
		const results = await Promise.all(chunks)
		results.forEach((res) => res.data.forEach((c) => { colorById[c._id] = c }))
		// 3. 组装品名树（颜色行序保持各品名 color_ids 顺序）
		let list = fabrics.map((f) => ({
			id: f._id,
			name: f.name || '',
			code: f.code || '',      // 产品编号
			width: f.width || '',    // 门幅
			weight: f.weight || '',  // 克重
			colors: (f.color_ids || []).map((id) => colorById[id]).filter(Boolean).map((c) => ({ id: c._id, name: c.name || '' })),
		}))
		const q = String(keyword || '').trim()
		if (q) {
			list = list.filter((f) => f.name.includes(q) || f.colors.some((c) => c.name.includes(q)))
		}
		return ok({ list })
	},

	/* ── 接口：面料选项（选择器用：轻量、免登录校验）
	 * 三种调用模式：
	 *   1) {}                                → 仅品名（id+name），向后兼容、原契约、体积轻
	 *   2) { keyword: '粉' }                 → 品名 + 颜色树，按 品名 OR 颜色 includes(keyword) 过滤
	 *   3) { withColors: true }              → 全量品名 + 颜色树（不过滤），供选择器本地搜索与切换即时显示
	 * 模式 2/3 走同一段「品名分页 + 颜色分批 in + 组装树」算法，
	 * 通过分页拉品名（≤1000/批）+ 分批 in 拉颜色（500/批并发）控制单次响应体积。
	 * 免登录校验：选择器在登录前后都可能用到 ── */
	async listOptions(params) {
		const { keyword = '', withColors = false } = params || {}
		const q = String(keyword).trim()
		const cmd = uniCloud.database().command

		// 模式 1：仅品名（无 keyword 且无 withColors），向后兼容
		if (!q && !withColors) {
			const LIMIT = 1000
			const list = []
			let offset = 0
			for (;;) {
				const res = await colFab().orderBy('sort', 'asc').field({ name: true }).skip(offset).limit(LIMIT).get()
				list.push(...res.data)
				if (res.data.length < LIMIT) break
				offset += LIMIT
			}
			return ok({ list: list.map((f) => ({ id: f._id, name: f.name || '' })) })
		}

		// 模式 2/3：分页拉全品名（含 color_ids 引用）
		const FAB_BATCH = 1000
		const fabrics = []
		let offset = 0
		for (;;) {
			const fabRes = await colFab().orderBy('sort', 'asc').field({ name: true, color_ids: true }).skip(offset).limit(FAB_BATCH).get()
			fabrics.push(...fabRes.data)
			if (fabRes.data.length < FAB_BATCH) break
			offset += FAB_BATCH
		}
		// 汇总引用颜色 id，并发分批 in 拉取名称（500/批）
		const colorIds = [...new Set(fabrics.reduce((s, f) => s.concat(f.color_ids || []), []))]
		const colorById = {}
		const COLOR_BATCH = 500
		const chunks = []
		for (let i = 0; i < colorIds.length; i += COLOR_BATCH) {
			chunks.push(
				colColor().where({ _id: cmd.in(colorIds.slice(i, i + COLOR_BATCH)) }).field({ name: true }).limit(COLOR_BATCH).get()
			)
		}
		const results = await Promise.all(chunks)
		results.forEach((res) => res.data.forEach((c) => { colorById[c._id] = c }))
		// 组装品名树（颜色行序按 color_ids 顺序）
		let list = fabrics.map((f) => ({
			id: f._id,
			name: f.name || '',
			colors: (f.color_ids || []).map((id) => colorById[id]).filter(Boolean).map((c) => ({ id: c._id, name: c.name || '' })),
		}))
		// 模式 2 才过滤；模式 3 返回全量
		if (q) {
			list = list.filter((f) => f.name.includes(q) || f.colors.some((c) => c.name.includes(q)))
		}
		return ok({ list })
	},

	/* ── 接口：某品名下的颜色（选择器/颜色管理用：轻量、免登录校验）
	 * 单品名颜色数量有限，一次 in 查询即可全量返回；行序保持品名 color_ids 顺序 ── */
	async listColors(params) {
		const { id } = params || {}
		if (!id) return ok({ list: [], name: '' })
		const fab = await colFab().doc(id).get()
		if (!fab.data.length) return ok({ list: [], name: '' })
		const ids = fab.data[0].color_ids || []
		if (!ids.length) return ok({ list: [], name: fab.data[0].name || '' })
		const cmd = uniCloud.database().command
		// limit(1000)：云函数端 get 默认上限 100 条，单品名颜色超 100 会被静默截断（「颜色不全」根因）
		const res = await colColor().where({ _id: cmd.in(ids) }).field({ name: true }).limit(1000).get()
		const byId = {}
		res.data.forEach((c) => { byId[c._id] = c.name || '' })
		return ok({
			name: fab.data[0].name || '',
			list: ids.filter((i) => byId[i]).map((i) => ({ id: i, name: byId[i] })),
		})
	},

	/* ── 接口：全局颜色搜索（颜色管理页「选取已有颜色」用：轻量、免登录校验）
	 * 全局颜色字典量级大（可达数千色），按关键词返回少量匹配，避免一次全量下发 ── */
	async colorOptions(params) {
		const { keyword = '' } = params || {}
		const q = String(keyword).trim()
		if (!q) return ok({ list: [] })
		const reg = new RegExp(q)
		const where = uniCloud.database().command.or([{ name: reg }, { color_code: reg }])
		const res = await colColor().where(where).orderBy('color_code', 'asc').field({ name: true }).limit(50).get()
		return ok({ list: res.data.map((c) => ({ id: c._id, name: c.name || '' })) })
	},

	/* ── 接口：新增品名
	 * code 产品编号 / width 门幅 / weight 克重：均为可选文本，标签打印时直接展示 ── */
	async addFabric(params) {
		const denied = await checkEditor(this)
		if (denied) return denied
		const { name, code = '', width = '', weight = '' } = params || {}
		const n = (name || '').trim()
		if (!n) return fail('请输入品名')
		const exists = await colFab().where({ name: n }).count()
		if (exists.total > 0) return fail('品名已存在')
		const now = Date.now()
		const addRes = await colFab().add({
			name: n,
			code: String(code || '').trim(),
			width: String(width || '').trim(),
			weight: String(weight || '').trim(),
			sort: 0,
			create_date: now,
			update_date: now,
		})
		return ok({ id: addRes.id })
	},

	/* ── 接口：更新品名（含产品编号 / 门幅 / 克重，传 undefined 的字段不修改） ── */
	async updateFabric(params) {
		const denied = await checkEditor(this)
		if (denied) return denied
		const { id } = params || {}
		if (!id) return fail('缺少品名id')
		const args = params || {}
		const data = { update_date: Date.now() }
		if (args.name !== undefined) {
			const n = String(args.name).trim()
			if (!n) return fail('品名不能为空')
			const cmd = uniCloud.database().command
			const exists = await colFab().where({ name: n, _id: cmd.neq(id) }).count()
			if (exists.total > 0) return fail('品名已存在')
			data.name = n
		}
		// 规格字段：统一存字符串，允许「155cm / 180g/m²」这类带单位的写法
		;['code', 'width', 'weight'].forEach((k) => {
			if (args[k] !== undefined) data[k] = String(args[k] || '').trim()
		})
		const res = await colFab().doc(id).update(data)
		if (!res.updated) return fail('品名不存在或未变更')
		return ok({ id })
	},

	/* ── 接口：删除品名（全局颜色字典不受影响；存在库存引用时禁止删除） ── */
	async removeFabric(params) {
		const denied = await checkAdmin(this)
		if (denied) return denied
		const { id } = params || {}
		if (!id) return fail('缺少品名id')
		// 防悬空引用：该品名若仍有库存细码，禁止删除
		const db = uniCloud.database()
		const used = await db.collection('stock_roll').where({ fabric_id: id }).count()
		if (used.total > 0) return fail('该品名存在库存记录，请先出库或盘点调整后再删除')
		await colFab().doc(id).remove()
		return ok({ id })
	},

	/* ── 接口：添加颜色（颜色为全局字典）
	 * 传 colorId 关联已有颜色；传 name 新建颜色（全局已存在同名则直接复用）并关联到品名 ── */
	async addColor(params) {
		const denied = await checkEditor(this)
		if (denied) return denied
		const { fabricId, colorId, name } = params || {}
		if (!fabricId) return fail('缺少品名id')
		const fab = await colFab().doc(fabricId).get()
		if (!fab.data.length) return fail('品名不存在')
		let color = null
		if (colorId) {
			const res = await colColor().doc(colorId).get()
			if (!res.data.length) return fail('颜色不存在')
			color = res.data[0]
		} else {
			const n = (name || '').trim()
			if (!n) return fail('请输入颜色名称')
			const exists = await colColor().where({ name: n }).limit(1).get()
			if (exists.data.length) {
				color = exists.data[0]
			} else {
				const now = Date.now()
				const addRes = await colColor().add({
					name: n,
					color_code: '',
					create_date: now,
					update_date: now,
				})
				color = { _id: addRes.id, name: n }
			}
		}
		const ids = (fab.data[0].color_ids || []).filter((id) => id !== color._id)
		ids.push(color._id)
		await colFab().doc(fabricId).update({ color_ids: ids, update_date: Date.now() })
		return ok({ id: color._id, name: color.name || '' })
	},

	/* ── 接口：移除颜色（从品名解除关联；颜色为全局字典，无任何品名/库存引用时才删除） ── */
	async removeColor(params) {
		const denied = await checkAdmin(this)
		if (denied) return denied
		const { id, fabricId } = params || {}
		if (!id) return fail('缺少颜色id')
		// 1. 从指定品名解除关联
		if (fabricId) {
			const fab = await colFab().doc(fabricId).get()
			if (fab.data.length) {
				const ids = (fab.data[0].color_ids || []).filter((cid) => cid !== id)
				await colFab().doc(fabricId).update({ color_ids: ids, update_date: Date.now() })
			}
		}
		// 2. 防悬空引用：仍有库存细码引用时仅解除关联，不删除字典
		const db = uniCloud.database()
		const used = await db.collection('stock_roll').where({ color_id: id }).count()
		if (used.total > 0) return ok({ id, unlinked: true })
		// 3. 仍被其他品名引用时仅解除关联
		const stillUsed = await colFab().where({ color_ids: id }).count()
		if (stillUsed.total > 0) return ok({ id, unlinked: true })
		await colColor().doc(id).remove()
		return ok({ id })
	},

	/* ── 接口：调整品名下颜色顺序（仅重排 color_ids，不增删、不改色）
	 * 拖拽 / ↑↓ 完成后调此接口持久化顺序：传新顺序的完整 id 数组 ── */
	async sortColors(params) {
		const denied = await checkEditor(this)
		if (denied) return denied
		const { fabricId, colorIds } = params || {}
		if (!fabricId) return fail('缺少品名id')
		if (!Array.isArray(colorIds)) return fail('colorIds 必须为数组')
		const fab = await colFab().doc(fabricId).get()
		if (!fab.data.length) return fail('品名不存在')
		const old = fab.data[0].color_ids || []
		// 长度+集合相等校验：防加塞/丢色/越权改其他品名
		if (old.length !== colorIds.length) return fail('颜色数量不一致')
		if (old.length) {
			const a = new Set(old), b = new Set(colorIds)
			if (a.size !== b.size || [...a].some((x) => !b.has(x))) return fail('颜色id与原列表不匹配')
		}
		await colFab().doc(fabricId).update({ color_ids: colorIds, update_date: Date.now() })
		return ok({ id: fabricId })
	},
}
