/* ════════════════════════════════════════════════════════════════
 * 快麦云（kuaimai）标签打印公共模块
 *   - buildLabelFields(order, item, fieldMap)：打样标签字段 → 内容 JSON
 *   - pushLabel(cfg, { sn, templateId, fields, times })：下发标签打印任务
 *   - queryTask(cfg, { sn, taskId })：回查任务状态
 *
 * 对接口径（已从官方 Java SDK kuaimai-core-1.3.6 反编译确认）：
 *   控制台/申请凭证  https://open.iot.kuaimai.com/#/home
 *   接口文档          https://cloudprint.kuaimai.com/#/openDev
 *   接口基地址        https://cloud.kuaimai.com/api/cloud
 *   标签打印接口      POST /api/cloud/print/tsplTemplatePrint
 *   回查接口          POST /api/cloud/print/result
 *   鉴权字段          accessKey + timestamp + sign（MD5，key升序 key+value 拼接后追加 secret）
 *   业务字段          sn / templateId / renderDataArray / printTimes
 *
 * ⚠ 校准指引：
 *   签名算法与参数名以官方文档为准；若联调时报「签名错误」，优先改 buildPayload/createSign。
 *   本模块把「可能随文档变化」的部分全部收在下面三处：
 *     ① API 配置（apiBase / pushPath / queryPath / signAlgorithm）→ uni-config-center 的 uni-kuaimai
 *     ② buildPayload / createSign → 请求体公共参数与签名算法
 *     ③ parseResult → 返回码解析
 *   成功判定从严：只有拿到明确的成功标志（code=0 / success=true 等）才算成功；
 *   返回体没有任何成功标志时一律抛错并带上原文，避免「提示已推送、机器不出纸」。
 *   pushLabel 返回 { raw, taskId }，raw 为快麦原始响应，调用方须落库留档（print_task.resp）。
 *   未配置凭证时抛出 NO_KUAIMAI_ACCOUNT，云对象会转成给用户的明确提示。
 * ════════════════════════════════════════════════════════════════ */

'use strict'

const crypto = require('crypto')

/** 读取快麦云配置（uni-config-center 插件 uni-kuaimai） */
function config() {
	const configCenter = require('uni-config-center')
	const cfg = configCenter({ pluginId: 'uni-kuaimai' }).config() || {}
	return {
		apiBase: String(cfg.apiBase || '').replace(/\/+$/, ''),
		pushPath: String(cfg.pushPath || '').replace(/^\/+/, ''),
		queryPath: String(cfg.queryPath || '').replace(/^\/+/, ''),
		appId: String(cfg.appId || ''),
		appSecret: String(cfg.appSecret || ''),
		signAlgorithm: String(cfg.signAlgorithm || 'none').toLowerCase(),
		fieldMap: cfg.fieldMap || {},
		timeout: Number(cfg.timeout) || 8000,
	}
}

/** 配置体检：缺哪项就报哪项，避免调用方拿到 HTTP 4xx 摸不着头脑 */
function assertConfigured(cfg) {
	if (!cfg.apiBase || !cfg.pushPath) {
		const e = new Error('未配置快麦云接口地址（uni-kuaimai 的 apiBase/pushPath）')
		e.code = 'NO_KUAIMAI_ACCOUNT'
		throw e
	}
	if (!cfg.appId || !cfg.appSecret) {
		const e = new Error('未配置快麦云 appId/appSecret（快麦云后台 → 系统集成）')
		e.code = 'NO_KUAIMAI_ACCOUNT'
		throw e
	}
}

/* ══════════════ 标签内容字段 ══════════════ */

/** 取样总米数（与页面标签「数量」同口径：sampleCuts 的 length 求和） */
function sampleMeters(item) {
	const cuts = (item && item.sampleCuts) || []
	const total = cuts.reduce((s, c) => s + (Number(c && c.length) || 0), 0)
	return Math.round(total * 10) / 10
}

/** 交付方式（备注里「交付：市场/快递」，无前缀则回退原备注） */
function deliveryOf(remark) {
	const r = String(remark || '')
	if (!r) return '普通打样'
	const m = /交付[：:]\s*([^,\s；;]+)/.exec(r)
	return m ? `交付：${m[1].trim()}` : r
}

/** 标签纯文本清洗：去掉首尾空白与换行（打印字段不需要多行） */
const clean = (v) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim()

/**
 * 打样标签字段 → 内容对象
 * @param {Object} order 订单主表（取 customer/remark）
 * @param {Object} item  明细行（取 name/color/sampleCuts）
 * @param {Object} fieldMap 字段名映射（快麦模板字段名与默认名不一致时用）
 * @returns {Object} 标签内容，键名即快麦模板字段名
 */
function buildLabelFields(order, item, fieldMap) {
	const defaults = {
		customer: clean(order && order.customer) || '—',
		product_name: clean(item && item.name) || '—',
		color: clean(item && item.color) || '—',
		quantity: sampleMeters(item),
		delivery: deliveryOf(order && order.remark),
		order_no: clean(order && order.no),
	}
	const map = fieldMap && typeof fieldMap === 'object' ? fieldMap : {}
	const out = {}
	Object.keys(defaults).forEach((k) => {
		out[map[k] || k] = defaults[k]
	})
	return out
}

/* ══════════════ 签名与请求 ══════════════ */

/**
 * 生成 MD5 签名。
 * 规则（来自 kuaimai-core-1.3.6 SignTool 反编译）：
 *   1. 排除 sign 本身，过滤值为 null / undefined / 空字符串的键
 *   2. 按 key 字母升序排列
 *   3. 逐个拼接 key + value（对象/数组先 JSON.stringify 再拼接）
 *   4. 末尾追加 appSecret，整体 MD5(hex 小写)
 * ⚠ 若联调报「签名错误」，先核对这个规则是否与官方文档一致。
 */
function createSign(params, secret) {
	const keys = Object.keys(params)
		.filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== null && params[k] !== '')
		.sort()
	let sb = ''
	for (const k of keys) {
		let v = params[k]
		if (typeof v === 'object') v = JSON.stringify(v)
		sb += k + String(v)
	}
	sb += secret
	return crypto.createHash('md5').update(sb, 'utf8').digest('hex')
}

/**
 * 构造带公共参数的请求体。
 * 快麦要求公共参数：accessKey / timestamp / sign；业务参数随后端点不同而变化。
 * 旧实现把 appSecret 明文发出去，现在只用来算 sign。
 */
function buildPayload(cfg, payload) {
	const timestamp = String(Date.now())
	const params = {
		accessKey: cfg.appId,
		...payload,
		timestamp,
	}
	params.sign = createSign(params, cfg.appSecret)
	return params
}

/* ── 返回体字段名（文档叫法不一，全部做兼容取值） ──
 * 业务码 / 成功标志 / 消息 三类字段名分开放，解析时按「有无」逐类判断。 */
const CODE_KEYS = ['code', 'errcode', 'errorCode', 'error_code', 'resultCode', 'result_code']
const FLAG_KEYS = ['success', 'isSuccess', 'is_success', 'ok']
const MSG_KEYS = ['msg', 'message', 'errmsg', 'errorMsg', 'error_msg', 'errorDescription', 'error_description']

/** 压成短文本：把「原始响应」直接写进给用户看的报错，现场即可对着文档改字段名 */
function snippet(v, max = 300) {
	let s
	if (typeof v === 'string') s = v
	else {
		try {
			s = JSON.stringify(v)
		} catch (e) {
			s = String(v)
		}
	}
	if (s === undefined || s === null) s = String(v)
	return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 在返回体里按候选字段名取第一个非空值 */
function pick(body, keys) {
	for (let i = 0; i < keys.length; i++) {
		const k = keys[i]
		if (body[k] !== undefined && body[k] !== null && body[k] !== '') return { key: k, value: body[k] }
	}
	return null
}

/** 业务成功值：0 / '0' / 200 / '200' / true / 'success' / 'ok'
 *  ⚠ 200 是兼容 HTTP 风格的业务码；若官方文档另有约定，改这里即可 */
function isOkValue(v) {
	if (v === 0 || v === true) return true
	const s = String(v).trim().toLowerCase()
	return s === '0' || s === '200' || s === 'true' || s === 'success' || s === 'ok'
}

function apiError(message, body) {
	const e = new Error(`快麦云返回错误：${message}`)
	e.code = 'KUAIMAI_API'
	e.body = body
	return e
}

/**
 * 统一解析返回。
 * ⚠ 必须「宁可误报、不可漏报」：旧实现把「返回体里没有 code 字段」当作成功，
 *   于是接口地址填错、或返回体根本不是快麦格式时，也会提示「已推送」——
 *   现场表现就是「提示推送成功，但一张不出、无从排查」。
 *   现在只有拿到明确的成功标志（code=0 / success=true）才算成功，
 *   其余一律抛错，并把快麦返回的原文带进报错，便于直接对着文档核对字段名。
 */
function parseResult(body, res) {
	const status = res && res.status
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		const e = new Error(`快麦云响应异常（HTTP ${status}）：${snippet(body)}`)
		e.code = 'KUAIMAI_BAD_RESP'
		throw e
	}
	if (status && (status < 200 || status >= 300)) {
		const e = new Error(`快麦云 HTTP ${status}：${snippet(body)}`)
		e.code = 'KUAIMAI_HTTP'
		e.body = body
		throw e
	}
	const msgHit = pick(body, MSG_KEYS)
	const msg = msgHit ? String(msgHit.value) : ''
	const codeHit = pick(body, CODE_KEYS)
	if (codeHit) {
		if (!isOkValue(codeHit.value)) throw apiError(msg || `${codeHit.key}=${codeHit.value}`, body)
		return body
	}
	const flagHit = pick(body, FLAG_KEYS)
	if (flagHit) {
		if (!isOkValue(flagHit.value)) throw apiError(msg || `${flagHit.key}=${flagHit.value}`, body)
		return body
	}
	throw apiError(`无法识别返回结果（原文：${snippet(body)}）`, body)
}

/** 从返回体里取云端任务号：data 可能是字符串，也可能是对象，字段名各家不一
 *  ⚠ 旧实现直接 String(body.data)，data 为对象时会得到 '[object Object]' 这种假任务号 */
function pickTaskId(body) {
	const d = body ? body.data : undefined
	const cands = []
	if (d && typeof d === 'object') {
		cands.push(d.taskId, d.task_id, d.id, d.orderId, d.order_id, d.printId, d.print_id, d.jobId, d.job_id)
	} else {
		cands.push(d)
	}
	cands.push(body.taskId, body.task_id, body.orderId, body.order_id)
	for (let i = 0; i < cands.length; i++) {
		const v = cands[i]
		if (v !== undefined && v !== null && v !== '' && typeof v !== 'object') return String(v)
	}
	return ''
}

/** HTTP 请求封装 */
async function request(cfg, path, payload) {
	assertConfigured(cfg)
	if (!path) {
		const e = new Error('未配置快麦云接口路径（uni-kuaimai 的 pushPath/queryPath）')
		e.code = 'NO_KUAIMAI_ACCOUNT'
		throw e
	}
	const url = `${cfg.apiBase}/${path}`
	let res
	try {
		res = await uniCloud.httpclient.request(url, {
			method: 'POST',
			contentType: 'json',
			dataType: 'json',
			timeout: cfg.timeout,
			headers: { 'Content-Type': 'application/json;charset=UTF-8' },
			data: buildPayload(cfg, payload),
		})
	} catch (e) {
		const err = new Error(`快麦云请求失败：${e.message || e}`)
		err.code = 'KUAIMAI_NETWORK'
		throw err
	}
	return parseResult(res && res.data, res)
}

/* ══════════════ 对外能力 ══════════════ */

/**
 * 下发标签打印任务
 * @param {Object} cfg   config() 的返回值
 * @param {Object} p     { sn, templateId, fields, times }
 * @returns {Object} { raw, taskId }
 */
async function pushLabel(cfg, { sn, templateId, fields, times = 1 }) {
	if (!sn) {
		const e = new Error('缺少打印机 SN')
		e.code = 'KUAIMAI_PARAM'
		throw e
	}
	if (!fields || !Object.keys(fields).length) {
		const e = new Error('标签内容为空')
		e.code = 'KUAIMAI_PARAM'
		throw e
	}
	const body = await request(cfg, cfg.pushPath, {
		sn: String(sn).trim(),
		templateId: templateId || '',
		renderDataArray: [fields],
		printTimes: Math.max(1, Number(times) || 1),
	})
	const taskId = pickTaskId(body)
	return { raw: body, taskId }
}

/**
 * 回查任务状态（部分文档叫 queryTask / getTask / result）。
 * 快麦回查需要同时传 sn 和 jobIds 数组。
 */
async function queryTask(cfg, { sn, taskId }) {
	if (!sn || !taskId) {
		const e = new Error('缺少打印机 SN 或快麦任务号')
		e.code = 'KUAIMAI_PARAM'
		throw e
	}
	const body = await request(cfg, cfg.queryPath, {
		sn: String(sn).trim(),
		jobIds: [String(taskId)],
	})
	return body.data || {}
}

module.exports = {
	config,
	buildLabelFields,
	pushLabel,
	queryTask,
}
