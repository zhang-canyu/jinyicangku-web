/* ════════════════════════════════════════════════════════════════
 * 芯烨云（xpyun）打印公共模块
 *   - buildTicketContent(order, opts)：出库/打样单聚合视图 → 芯烨票据 content 文本（80mm 小票）
 *   - signSha1 / pushTicket：签名 + HTTPS 推送（print 票据）
 *   - addPrinter / queryOrderState：绑定回查辅助
 * （打样标签已改为前端蓝牙直连 TSPL，云标签通道 printLabel 已下线）
 *
 * 对接口径（xpyun 开放 API v1.9）：
 *   base    https://open.xpyun.net/api/openapi/xprinter
 *   鉴权    公共参数 user / timestamp(10位秒) / sign
 *           sign = SHA1( user + UserKEY + timestamp )，40 位小写
 *   ★ 注意：网上旧资料有 MD5 / 老域名写法，务必以官方
 *     《芯烨云开放API开发接入文档》PDF 为准；此模块按现行 SHA1 实现。
 *
 * 排版说明（热敏票据，全项目统一 80mm 纸）：
 *   FontA 字符宽 12 点、纸面 8 点/mm，官方《打印小票订单》给出的行容量：
 *     80mm 纸 576 点 → 每行 48 个半角字符（24 个汉字）
 *   渲染按“半角等效宽”计算（中文计 2、ASCII 计 1；非 ASCII 一律保守按 2 计，
 *   避免 ·、¥ 这类 GBK 全角符号被低估成 1 宽，使满行右对齐被打印机折行）。
 *   列宽、截断长度、分隔线一律取自行宽，不做纸宽换算。
 *   整票只用两级字号：放大一倍（<B>/<CB>，行宽减半为 24 半角）= 客户行 / 细码段，其余正文一律普通字号、不加粗；
 *     正文所有行一律从第 1 格起排（明细首行与细码段同一起始列，都不加缩进）——
 *       放大后空格宽度各家机型与普通字号并不一致，靠空格缩进必然对不齐，故正文一律顶格左对齐；
 *       仅票尾「合计」「落款」两行整行居中（居中不靠空格补位，不受各机型空格宽度差异影响）；
 *     明细首行「[序号] 品名·颜色（左对齐）+ 库位（右对齐）」普通字号，48 宽内必定同一行、不折行；
 *     每款顺序：明细首行 → 细码段（<L><B><RH n="5">：左对齐、放大一倍、不加粗）→ 本款条数/米数（普通字号、贴右）；
 *     票头只有一条粗线；票尾「合计（放大一倍、居中）」+（withPrice=true 时）「单价·金额（左右两列）」由粗线收口，
 *     最后一行是落款「锦一仓库 出库单」（普通字号、整行居中、不放大）；
 *     每一行行尾统一写两个 <BR>（= 加一空行），故正文里不再另插空行、款与款之间也不再补空行；
 *     放大行按 24 排版，内容超宽时自动退回普通字号，绝不让打印机折行。
 *   换行 / 对齐 / 字号 / 加粗全部走芯烨 content 标签，写法见下方 TAGS
 *   （依据官网《打印小票订单》接入指引 https://www.xpyun.net/open/ ）。
 * ════════════════════════════════════════════════════════════════ */

'use strict'

const crypto = require('crypto')

/** 行尾换行：官方约定「连续两个 <BR> = 加一空行」。
 *  整票统一用它当行尾 —— 每行之后都留一空行，行距拉开、便于逐行核对；
 *  ⚠ 因为每行后都已空一行，正文里不要再额外插空行（会连成两行空白）。 */
const BR = '<BR><BR>'

/* ══════════════ 芯烨 content 排版标签 ══════════════
 * 依据官网《打印小票订单》接入指引：
 *   换行  <BR>（连续两个 <BR><BR> = 加一空行）
 *   对齐  <L></L> 左 / <C></C> 中 / <R></R> 右
 *   字号  <N> 正常 / <HB> 倍高 / <WB> 倍宽 / <B> 倍高倍宽 / <CB> 倍高倍宽且居中
 *         <HB2> 高两倍 / <WB2> 宽两倍 / <B2> 放大两倍
 *         <FONT w="0" h="0">内容</FONT> 任意倍数（w/h 取 0-7）
 *   加粗  <BOLD></BOLD>
 * ⚠ 三个易踩的坑：
 *   1) <BR> 必须写在闭合标签「里面」——<C>内容<BR></C>；写在 </C> 之后居中/居右不生效；
 *   2) 同一行不可混用多种对齐方式，需要组合时用空格手工对齐；
 *   3) 空标签会报 1004 ADD_ORDER_FAILED，故标签一律包住非空内容。
 * 另：<CUT> 切纸、<QRCODE>/<BARCODE> 依赖机型硬件，按需在票尾追加。 */
const TAGS = {
	/** 普通行：默认即左对齐，不加标签最省事，也少一分被误判非法标签的风险 */
	left: (t) => `${t}${BR}`,
	/** 整行居中 */
	center: (t) => `<C>${t}${BR}</C>`,
	/** 票据大标题：<CB> 已自带「放大一倍 + 居中」，无需再套 <C>
	 *  （票面标题已下移票尾作落款，此处暂无调用方，留作备用） */
	title: (t) => `<CB>${t}${BR}</CB>`,
	/** 加粗行：普通字号 + 加粗（票面已全部取消加粗，留作备用标签） */
	bold: (t) => `<BOLD>${t}${BR}</BOLD>`,
	/** 放大一整段（<L> 左对齐 + <B> 放大一倍、不加粗），段内自带 <BR>。
	 *  ⚠ 倍宽 → 每行只有 LINE_WIDTH_BIG（24 半角），调用方须按 24 折行；
	 *  ⚠ 官方 content 标签表里没有 <LB>，左对齐放大须写成 <L><B> 两个标签嵌套。 */
	bigLeft: (t) => `<L><B>${t}</B></L>`,
	/** 合计行：<C> 居中 + <B> 放大一倍（不加粗）。
	 *  ⚠ 官方同样没有 <CB>，居中放大须写成 <C><B> 两个标签嵌套；
	 *  ⚠ 放大后行宽减半（LINE_WIDTH_BIG 24 半角），内容超宽须由调用方先退回普通字号。 */
	bigCenter: (t) => `<C><B>${t}${BR}</B></C>`,
	/** 明细细码段：<L> 左对齐 + <B> 放大一倍（不加粗）+ <RH n="5"> 行距。
	 *  ⚠ <B> 为倍高倍宽 → 字符占 2 格、每行容量减半为 24 半角，故该段折行按 24 排版；
	 *  <RH> 必须夹在 <L> 之间、且放在字号标签内层；官方已弃用 RH（改用 <LH h="…">），
	 *  行距只在该段内容 ≥2 行时生效，故整段一次性包住、而不是逐行包。 */
	rolls: (t) => `<L><B><RH n="5">${t}</RH></B></L>`,
	/** 单号回查二维码（依赖机型，默认关闭）。开启示例：
	 *  (no) => `<QRCODE s=6 e=L l=center>${no}</QRCODE><BR>` —— 内容不能含空格 */
	qr: null,
}

/** 取标签函数（未知样式按左对齐兜底） */
const tagOf = (kind) => (typeof TAGS[kind] === 'function' ? TAGS[kind] : TAGS.left)

/* ══════════════ 基础工具 ══════════════ */
/** 单字符半角等效宽：ASCII 可打印字符（0x20-0x7E）计 1，其余一律计 2。
 *  ⚠ 必须保守——·、¥、— 等符号在 GBK 下按全角 2 宽渲染，若按 1 计，
 *    满行（48 宽）的右对齐会被打印机折行，「品名·颜色 / 库位」就会错位跑成两行。 */
const charW = (c) => {
	const code = c.charCodeAt(0)
	return code >= 0x20 && code <= 0x7e ? 1 : 2
}

/** 半角等效宽度：中文/全角计 2，ASCII 计 1 */
function cw(s) {
	let n = 0
	const str = String(s == null ? '' : s)
	for (let i = 0; i < str.length; i++) n += charW(str[i])
	return n
}

/** 转义：把可能被云平台当作标签解析的字符换成全角，避免污染排版 */
const safe = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/</g, '＜').replace(/>/g, '＞')

/** 按半角宽度截断，超长补 … */
function fit(s, max) {
	let t = safe(s)
	if (cw(t) <= max) return t
	let keep = 0
	let w = 0
	const arr = Array.from(t)
	for (let i = 0; i < arr.length; i++) {
		const cw2 = charW(arr[i])
		if (w + cw2 + 1 > max) break // 预留「…」1 宽
		w += cw2
		keep = i + 1
	}
	return arr.slice(0, keep).join('') + '…'
}

/** 行包装：按半角宽度 max 折行，返回行数组 */
function wrap(s, max) {
	let t = safe(s)
	if (cw(t) <= max) return [t]
	const out = []
	const arr = Array.from(t)
	let line = ''
	let w = 0
	for (let i = 0; i < arr.length; i++) {
		const c = arr[i]
		const cw2 = charW(c)
		if (w + cw2 > max) {
			out.push(line)
			line = ''
			w = 0
		}
		line += c
		w += cw2
	}
	if (line) out.push(line)
	return out
}

/** 同一行左右两段：左段居左、右段贴右边界，中间空格补齐。
 *  热敏票为等宽字体，空格对齐可靠；右段多为「库位 / 日期 / 金额」等关键信息，
 *  故左段至少让出 14 格，右段封顶后先截断左段 —— 保证右列完整、且整行不折行。 */
const LEFT_MIN = 14
function pairLR(left, right, W) {
	let r = safe(right)
	const rMax = Math.max(6, W - LEFT_MIN)
	if (cw(r) > rMax) r = fit(r, rMax)
	let l = safe(left)
	const room = W - cw(r) - 1
	if (cw(l) > room) l = fit(l, room)
	return l + ' '.repeat(Math.max(1, W - cw(l) - cw(r))) + r
}

/** 单行右对齐：左补空格把文本推到右边界（超宽由调用方先 fit；此处只保证不折行） */
function alignRight(s, W) {
	const t = fit(s, W)
	return ' '.repeat(Math.max(0, W - cw(t))) + t
}

/* ══════════════ 行宽（统一 80mm 纸） ══════════════
 * 芯烨 FontA 字符宽 12 点、热敏纸 8 点/mm，80mm 纸可打印 72mm = 576 点
 *   → 每行 48 个半角字符（24 个汉字）。
 * 列宽、截断长度、分隔线一律由行宽派生，避免「分隔线短一截、列错位」。
 * ⚠ 全项目统一按 80mm 纸排版，不做纸宽换算；超宽的行会被打印机自行折行、版面错乱。 */
const LINE_WIDTH = 48

/** 放大一倍（<B>/<CB> 倍高倍宽）后的行宽：字符占 2 格，容量减半 */
const LINE_WIDTH_BIG = Math.floor(LINE_WIDTH / 2)

/** 分隔线：铺满行宽；ch='=' 用于票头/票尾的粗线 */
const rule = (W, ch = '-') => ch.repeat(W)

/* ══════════════ 单据排版 ══════════════ */
/**
 * 出库/打样单聚合视图 → content
 * @param {Object} order outbound-manage.get 的聚合视图（含 items）
 * @param {Object} opts  { withPrice=false }
 */
function buildTicketContent(order, opts = {}) {
	const W = LINE_WIDTH
	// 放大一倍的行（细码段）行宽减半，折行按 WB 排版
	const WB = LINE_WIDTH_BIG
	const items = Array.isArray(order.items) && order.items.length ? order.items : []
	const isSample = order.source === 'sample'
	const fmtM = (v) => {
		const n = Number(v)
		return isFinite(n) ? parseFloat(n.toFixed(1)) : 0
	}
	const sampleLenText = (it) => {
		const lens = (it.sampleCuts || []).map((c) => fmtM(c.length)).filter((v) => v > 0)
		return lens.length ? lens.map((v) => v).join('/') : ''
	}
	const locText = (it) => {
		const locs = (it.locations || []).filter(Boolean)
		return (locs.length ? locs : it.location ? [it.location] : []).join('/') || '—'
	}
	/** 出库单某款的「数量」文本（已配货取实际，待配货取需求） */
	const qtyOf = (it) => {
		const hasRolls = (it.rolls || []).length > 0
		const cnt = hasRolls ? (it.rolls || []).length : Number(it.demandCount) || 0
		return `${cnt} 条 / ${fmtM(hasRolls ? it.total_meters : it.demandMeters)} 米`
	}
	const locOf = (it) => safe(`库位 ${locText(it)}`)

	// 汇总（与打印预览口径一致：非打样取配货实际；打样取下单需求）
	const totalCount = isSample ? items.reduce((s, it) => s + (Number(it.demandCount) || 0), 0) : Number(order.count) || items.reduce((s, it) => s + (Number(it.count) || (it.rolls || []).length || 0), 0)
	const totalMeters = isSample ? items.reduce((s, it) => s + (Number(it.demandMeters) || 0), 0) : Number(order.total_meters) || items.reduce((s, it) => s + (Number(it.total_meters) || 0), 0)

	// 每行行尾自带 <BR><BR>（换行 + 一空行），故最终直接拼接（不再用 \n）
	const out = []
	/** 左对齐普通行 */
	const push = (s) => out.push(tagOf('left')(s))
	/** 折行输出：长文本按行宽自动续行，不丢信息 */
	const emit = (s) => wrap(s, W).forEach((l) => out.push(tagOf('left')(l)))
	/** 放大整段输出（客户行等）：按 24 半角折行，整段一次性包 <L><B>。
	 *  ⚠ 放大后空格宽度各家机型不一致、倍宽下每行又只 24 格，故续行不缩进、整段顶格。 */
	const emitBig = (s) => out.push(tagOf('bigLeft')(wrap(s, WB).map((l) => `${l}${BR}`).join('')))
	/** 汇总 / 数量行：普通字号、不加粗，整行贴右边界（行宽 W，48 半角足够，不会折行） */
	const pushSum = (s) => push(alignRight(s, W))

	/* ── 票头：一条粗线开票 ──
	 * 「锦一仓库 出库单」不再占票头（放大居中会喧宾夺主），改作票尾落款（见票尾），
	 * 使客户 / 单号等关键信息在票面最上方先被看到。 */
	push(rule(W, '='))

	/* ── 元信息：客户独占一行（<L><B> 左对齐 + 放大一倍）；单号/日期、操作员/状态 两列成格（右列值贴右边界） ── */
	emitBig(`客户：${safe(order.customer || '-')}`)
	push(pairLR(`单号：${safe(order.no || '-')}`, `日期：${safe(order.date || '-')}${order.time ? ' ' + safe(order.time) : ''}`, W))
	push(pairLR(`操作员：${safe(order.operator || '-')}`, `状态：${safe(order.status || '')}`, W))

	/* ── 明细：一款一段（首行 品名·颜色 + 库位 → 卷号 → 本款条数/米数） ── */
	push(rule(W))
	if (!items.length) push('（无明细）')
	items.forEach((it, idx) => {
		const no = String(idx + 1).padStart(2, '0')
		/* 首行：序号 + 品名·颜色 顶格居左，库位贴右边界 —— 统一普通字号（不加任何放大标签），
		 * 行宽 48 足够容纳，故两者必定同一行、且不会被打印机自行折行。 */
		push(pairLR(`[${no}] ${safe(it.name || '')}·${safe(it.color || '')}`, locOf(it), W))

		if (isSample) {
			// 打样单：取样长度是明细列表，顶格左对齐；需求条数/米数右对齐收尾
			push(`取样 ${sampleLenText(it) || '—'}`)
			const dc = Number(it.demandCount) || 0
			if (dc > 0) pushSum(`需求 ${dc} 条 / ${fmtM(it.demandMeters)} 米`)
		} else {
			/* 卷号：不加文字标签，直接铺卷码；整段一次性包 <L><B><RH n="5">。
			 * <B> 放大一倍（倍高倍宽、不加粗）→ 字符占 2 格，故按减半行宽 WB 折行；
			 * <RH> 行距覆盖段内每一行（待配货无卷号则跳过）。
			 * ⚠ 段首不留空格：放大后空格宽度与普通字号下的并不一致（各家机型不同），
			 *   靠空格做缩进必然与上一行「[01]」对不齐，故整票统一顶格（从第 1 格起排）。 */
			const rolls = it.rolls || []
			if (rolls.length) {
				const room = WB
				const rollLines = []
				let line = ''
				const flushRolls = () => {
					if (!line) return
					rollLines.push(line)
					line = ''
				}
				rolls.forEach((r) => {
					const code = String(r)
					if (!line) {
						line = fit(code, room)
						return
					}
					if (cw(`${line} ${code}`) > room) {
						flushRolls()
						line = fit(code, room)
					} else {
						line = `${line} ${code}`
					}
				})
				flushRolls()
				out.push(tagOf('rolls')(rollLines.map((l) => `${l}${BR}`).join('')))
			}
			/* 本款条数 / 米数：普通字号、贴右边界收尾 */
			pushSum(qtyOf(it))
		}

		// 款与款之间不再额外插空行：每行行尾已是 <BR><BR>（自带一空行），
		// 再补一行空白就会连成两行空白、且各款间距反而忽宽忽窄
	})

	/* ── 票尾：合计（普通字号、贴右，与每款收尾 pushSum 同式）+ 单价/金额（两列）+ 收货地址/备注，由粗线收口 ── */
	push(rule(W))
	/* 合计：去掉 2 倍字号，与米数汇总（每款收尾 pushSum）样式一致 —— 普通字号、整行贴右边界。
	 *  ⚠ 回归两级字号体系（普通 + 客户/细码 2 倍），减少票尾锚点密度，避免地址/备注也升至 2 倍后
	 *     票尾「2 倍锚点」过于密集；与每款收尾的 pushSum(qtyOf(it)) 同字号、同对齐，便于仓管逐款核对。
	 *  ⚠ 普通字号下行宽 W=48 半角足够，「合计 N 条 / X 米」不会折行，无需退档判断。 */
	const sumText = isSample ? `合计  ${fmtM(totalMeters)} 米` : `合计  ${totalCount} 条 / ${fmtM(totalMeters)} 米`
	pushSum(sumText)
	// 价格（口径与预览一致：整单有已定价行才出；withPrice 由调用方按角色决定）
	if (opts.withPrice) {
		const s = billSummary(order)
		// 单价 / 金额：普通字号、不加粗，左右两列成格（金额贴右边界），一行放完不折行
		if (s) push(pairLR(`单价  ${s.priceText}/${s.unitWord}`, `金额  ¥${s.amountText}`, W))
	}
	/* ── 收货地址 / 备注：字号与客户信息一致（<L><B> 放大一倍），仅显示字段内容，两者都有时中间加明细分割线 ──
	 *  ⚠ 字号升至 2 倍（字高 48 点 / 6mm），与客户行同层级 → 补充信息视觉权重提升；
	 *     整段一次性包 <L><B>，长文本按 WB=24 半角自动折行（每行 12 汉字），续行顶格。
	 *  ⚠ 不再带「收货地址：」「备注：」前缀 —— 纯字段内容，让 2 倍字号突出信息本身而非标签。
	 *  ⚠ 地址与备注是独立可选字段，两者都有时中间用明细分割线（'-'）分隔；仅其一则不补空线。
	 *  ⚠ 此举打破原「两级字号」体系（普通 + 2 倍），地址/备注成了第二个 2 倍锚点——
	 *     与细码段视觉同级（合计行已降为普通字号），需评估票面节奏是否仍清晰。 */
	const hasAddr = !!order.address
	const hasRemark = !!order.remark
	if (hasAddr) emitBig(safe(order.address))
	if (hasAddr && hasRemark) push(rule(W))
	if (hasRemark) emitBig(safe(order.remark))
	push(rule(W, '='))
	// 落款：店名 + 单据名（原票头放大居中标题下移至此），普通字号、整行居中、不放大
	out.push(tagOf('center')(`锦一仓库 ${isSample ? '打 样 单' : '出 库 单'}`))
	if (TAGS.qr) out.push(TAGS.qr(safe(order.no || '')))
	return out.join('')
}

/** 整单价格摘要（云端副本，口径与 utils/print.billSummary 一致） */
function billSummary(order) {
	if (!order) return null
	const items = Array.isArray(order.items) && order.items.length ? order.items : []
	const unitPriceText = (v) => {
		const n = Math.round((Number(v) || 0) * 10) / 10
		return Number.isInteger(n) ? String(n) : n.toFixed(1)
	}
	const priced = items.find((it) => it.price !== undefined && it.price !== null)
	if (!priced) return null
	const unit = priced.unit === 'count' ? 'count' : 'meters'
	let total = 0
	items.forEach((it) => {
		if (it.price === undefined || it.price === null) return
		if (it.amount !== undefined && it.amount !== null) {
			total += Number(it.amount)
			return
		}
		let qty = 0
		if (unit === 'count') {
			qty = Number(it.count) || (it.rolls || []).length || Number(it.demandCount) || 0
		} else {
			let m = Number(it.total_meters)
			if (!(m > 0)) m = (it.rolls || []).reduce((s, v) => s + Number(v), 0) || Number(it.demandMeters) || 0
			qty = Math.round(m * 10) / 10
		}
		total += qty * Number(it.price)
	})
	total = Math.round(total * 100) / 100
	return {
		priceText: `¥${unitPriceText(priced.price)}`,
		unitWord: unit === 'count' ? '条' : '米',
		amountText: String(Math.round(total)),
	}
}

/* ══════════════ 鉴权与 HTTP ══════════════ */
function signSha1(user, userKey, timestamp) {
	return crypto.createHash('sha1').update(`${user}${userKey}${timestamp}`, 'utf8').digest('hex')
}

/**
 * 芯烨云 HTTP 请求封装（统一公共参数 + 签名）
 * @param {Object} cfg   { user, userKey, apiBase, timeout }
 * @param {String} action 接口相对路径，如 'print' / 'addPrinters' / 'queryOrderState'
 * @param {Object} payload 私有参数
 * @returns {Object} { code, msg, data }
 */
async function request(cfg, action, payload = {}) {
	const { user, userKey, apiBase, timeout = 8000 } = cfg || {}
	if (!user || !userKey) {
		const e = new Error('未配置芯烨云开发者账号（user/UserKEY）')
		e.code = 'NO_XPYUN_ACCOUNT'
		throw e
	}
	if (!apiBase) {
		const e = new Error('未配置芯烨云接口地址')
		e.code = 'NO_API_BASE'
		throw e
	}
	const timestamp = String(Math.floor(Date.now() / 1000))
	const sign = signSha1(user, userKey, timestamp)
	const url = `${apiBase.replace(/\/+$/, '')}/${action}`
	let res
	try {
		res = await uniCloud.httpclient.request(url, {
			method: 'POST',
			contentType: 'json',
			dataType: 'json',
			timeout,
			headers: { 'Content-Type': 'application/json;charset=UTF-8' },
			data: { user, timestamp, sign, ...payload },
		})
	} catch (e) {
		const err = new Error(`芯烨云请求失败：${e.message || e}`)
		err.code = 'XPYUN_NETWORK'
		throw err
	}
	const body = res && res.data
	// 芯烨返回 { code, msg, data }，code=0 成功；HTTP 非 2xx 或空体按网络异常处理
	if (!body || body.code === undefined) {
		const err = new Error(`芯烨云响应异常（HTTP ${res && res.status}）`)
		err.code = 'XPYUN_BAD_RESP'
		throw err
	}
	return body
}

/** 推送小票订单（print）。返回 { xpyunOrderId }（芯烨 data 即订单号）
 *  ⚠ 份数入参沿用业务侧的 times，但落到接口的字段名必须是 copies ——
 *    官方 print 接口只认 copies，旧资料里的 times 会被当成无效参数忽略（结果只打 1 份）。 */
async function pushTicket(cfg, { sn, content, times = 1 }) {
	if (!sn || !content) {
		const e = new Error('缺少推送参数（sn/content）')
		e.code = 'XPYUN_PARAM'
		throw e
	}
	const body = await request(cfg, 'print', { sn, content, copies: times })
	if (body.code !== 0) {
		let msg = body.msg || body.code
		const msgText = String(msg)
		if (msgText.includes('PRINTER_NOT_REGISTER')) {
			msg += '（该 SN 未在芯烨开放平台注册，请登录 admin.xpyun.net → 打印管理 → 设备管理 添加打印机）'
		/* 离线两种错误码都覆盖：PRINTER_NOT_ONLINE（旧文档）/ PRINTER_OFFLINE（现行，实际线上多返回此码） */
		} else if (msgText.includes('PRINTER_NOT_ONLINE') || msgText.includes('PRINTER_OFFLINE')) {
			msg += '（打印机离线，请检查电源/网络；如刚开机需等待 1-2 分钟联网后再试）'
		} else if (msgText.includes('PRINTER_NOT_SUPPORT')) {
			msg += '（该机型不支持此打印类型，请确认是否 80mm 云票据机）'
		}
		const err = new Error(`芯烨云返回错误：${msg}`)
		err.code = 'XPYUN_API'
		err.xpyun = body
		throw err
	}
	return { xpyunOrderId: body.data != null ? String(body.data) : '' }
}

/** 绑定打印机到开发者账号（addPrinters，可批量）。devices: [{ sn, name }]
 *  ⚠ 官方 addPrinters 的字段名是 items（不是 snList），元素为 { sn, name } 且两者必填。
 *    机身 key 不参与注册请求（仅入库备查），故这里不校验 key。 */
async function bindPrinter(cfg, devices) {
	const items = (devices || [])
		.filter((d) => d && d.sn)
		.map((d) => ({ sn: String(d.sn).trim(), name: String(d.name || d.sn).trim() }))
	if (!items.length) {
		const e = new Error('缺少待绑定打印机（sn）')
		e.code = 'XPYUN_PARAM'
		throw e
	}
	const body = await request(cfg, 'addPrinters', { items })
	if (body.code !== 0) {
		const err = new Error(`绑定打印机失败：${body.msg || body.code}`)
		err.code = 'XPYUN_API'
		err.xpyun = body
		throw err
	}
	return { added: body.data }
}

/** 回查订单打印状态。orderId 为芯烨返回的订单号 */
async function queryOrderState(cfg, xpyunOrderId) {
	if (!xpyunOrderId) {
		const e = new Error('缺少芯烨订单号')
		e.code = 'XPYUN_PARAM'
		throw e
	}
	const body = await request(cfg, 'queryOrderState', { orderId: xpyunOrderId })
	if (body.code !== 0) {
		const err = new Error(`芯烨云返回错误：${body.msg || body.code}`)
		err.code = 'XPYUN_API'
		err.xpyun = body
		throw err
	}
	// data: { orderId, status: 0 未打印 / 1 已打印 / 2 打印失败, ... }
	return body.data || {}
}

module.exports = {
	buildTicketContent,
	billSummary,
	signSha1,
	request,
	pushTicket,
	bindPrinter,
	queryOrderState,
}
