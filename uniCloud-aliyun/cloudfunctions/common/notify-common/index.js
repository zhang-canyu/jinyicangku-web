'use strict'

/* ════════════════════════════════════════════════════════════════
 * 订阅消息通知公共模块 — 出库单状态变更通知
 *
 * 通道：微信小程序订阅消息（一次性订阅，额度由前端下单成功页 uni.requestSubscribeMessage 攒取）
 * 兜底：无论发送成败，先写 notify-log（后续应用内消息中心/红点可复用）
 *
 * 模板：订单状态通知（公众平台 → 订阅消息）
 *   character_string4.DATA 订单号
 *   thing9.DATA            客户姓名（thing ≤20 字）
 *   phrase8.DATA           订单状态（phrase ≤5 字）
 *
 * 使用约束：
 *   1. 只允许在业务云函数「事务 commit 之后」调用（事务外副作用，与 touchCustomers 同口径）
 *   2. 调用方需 try/catch 包裹，通知失败不影响单据主流程
 * ════════════════════════════════════════════════════════════════ */

const createConfig = require('uni-config-center')

/* 订阅消息模板 ID（更换模板时同步修改 data 字段键名） */
const TMPL_ALLOCATED = 'UfxAWP64k41EfX_eCoimO-r1YL29SLQDu5SUHCl-E7g'

/* 点击通知跳转的出库单详情页 */
function detailPath(no) {
	return `pages/detail/detail-out?no=${encodeURIComponent(no || '')}`
}

/* access_token 内存缓存：同一热实例复用，冷启动重取（本场景发送频率低，可接受） */
let _tokenCache = { token: '', expire: 0 }

/* mp-weixin appid/appsecret：复用 uni-config-center/uni-id/config.json 的 mp-weixin.oauth.weixin */
function mpConfig() {
	const cfg = createConfig({ pluginId: 'uni-id' }).config() || {}
	const mp = (cfg['mp-weixin'] && cfg['mp-weixin'].oauth && cfg['mp-weixin'].oauth.weixin) || {}
	return { appid: mp.appid || '', appsecret: mp.appsecret || '' }
}

async function getAccessToken() {
	const now = Date.now()
	if (_tokenCache.token && now < _tokenCache.expire) return _tokenCache.token
	const { appid, appsecret } = mpConfig()
	if (!appid || !appsecret) {
		throw new Error('缺少小程序 appid/appsecret（uni-config-center/uni-id/config.json → mp-weixin.oauth.weixin）')
	}
	const res = await uniCloud.httpclient.request('https://api.weixin.qq.com/cgi-bin/token', {
		method: 'GET',
		/* 微信该接口参数名为 secret（非 appsecret），传错报 41004 appsecret missing */
		data: { grant_type: 'client_credential', appid, secret: appsecret },
		dataType: 'json',
		timeout: 8000,
	})
	const body = (res && res.data) || {}
	if (!body.access_token) throw new Error('获取 access_token 失败：' + JSON.stringify(body))
	/* 提前 5 分钟过期，避免临界点拿到失效 token */
	_tokenCache = { token: body.access_token, expire: now + ((Number(body.expires_in) || 7200) - 300) * 1000 }
	return _tokenCache.token
}

/* thing 类型截断（≤20 字）；空值兜底 */
function thing(v, fallback) {
	const s = String(v == null ? '' : v).trim().slice(0, 20)
	return s || fallback
}

/* 发送订阅消息（低层）：失败抛错，由上层记录
 * access_token 拼 URL 查询串、body 为纯 JSON 字符串（微信接口标准调用方式） */
async function sendSubscribe(openid, templateId, page, data) {
	const token = await getAccessToken()
	const res = await uniCloud.httpclient.request(
		`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`,
		{
			method: 'POST',
			content: JSON.stringify({ touser: openid, template_id: templateId, page, data }),
			contentType: 'json',
			dataType: 'json',
			timeout: 8000,
		},
	)
	const body = (res && res.data) || {}
	if (body.errcode !== 0) throw new Error(`订阅消息发送失败 errcode=${body.errcode} errmsg=${body.errmsg || ''}`)
	return body
}

/* 写 notify-log：先写后发，发送结果回写（兜底应用内消息中心） */
async function writeLog(log) {
	try {
		await uniCloud.database().collection('notify-log').add(log)
	} catch (e) {
		// 日志落库失败不影响通知主流程
	}
}

/* ── 配货完成通知下单营业员（allocate：待配货→待确认；sampleAllocate：待配货→已完成）──
 * order：主表记录（需含 _id/no/customer/created_by）；statusTo 文案随流转类型传入。
 * 无 created_by（仓管直接出库单）不通知——配货人即建单人，无信息差。
 * 全程静默失败，返回 { sent, reason } 仅供调用方日志参考 */
async function notifyOrderAllocated(order, operatorName, statusTo = '已配货') {
	const res = { sent: false, reason: '' }
	try {
		if (!order || !order._id) { res.reason = 'invalid_order'; return res }
		const receiver = String(order.created_by || '').trim()
		if (!receiver) { res.reason = 'no_receiver'; return res }

		const no = String(order.no || '')
		const log = {
			event: 'allocated',
			order_id: String(order._id),
			order_no: no,
			customer: String(order.customer || ''),
			receiver_uid: receiver,
			status_from: '待配货',
			status_to: statusTo,
			operator: String(operatorName || ''),
			channel: 'subscribe',
			sent: false,
			reason: '',
			create_date: Date.now(),
		}

		/* 查接收人小程序 openid：uni-id-users.wx_openid 对象键随绑定端而异——
		 * uni-id-co 在小程序端写入的键为 "mp"（getWeixinPlatform 对 mp-weixin 返回 'mp'），
		 * 另有 "mp_<dcloudAppId>" 冗余键；兼容历史字符串形态与旧键名，兜底取对象内任意值 */
		const db = uniCloud.database()
		const ures = await db.collection('uni-id-users').doc(receiver).field({ wx_openid: true }).get()
		const u = ures && ures.data && ures.data[0]
		const wxo = u && u.wx_openid
		let openid = ''
		if (typeof wxo === 'string') {
			openid = wxo
		} else if (wxo && typeof wxo === 'object') {
			openid = wxo['mp'] || wxo['mp-weixin'] || ''
			if (!openid) {
				const vals = Object.values(wxo).filter((v) => typeof v === 'string' && v)
				openid = vals[0] || ''
			}
		}
		if (!openid) {
			log.reason = 'no_openid'
			await writeLog(log)
			res.reason = log.reason
			return res
		}

		await sendSubscribe(openid, TMPL_ALLOCATED, detailPath(no), {
			character_string4: { value: no.slice(0, 32) || '-' },
			thing9: { value: thing(order.customer, '客户未填') },
			phrase8: { value: String(statusTo || '已配货').slice(0, 5) },
		})
		log.sent = true
		await writeLog(log)
		res.sent = true
		return res
	} catch (e) {
		res.reason = String((e && e.message) || e)
		try {
			await writeLog({
				event: 'allocated',
				order_id: String((order && order._id) || ''),
				order_no: String((order && order.no) || ''),
				customer: String((order && order.customer) || ''),
				receiver_uid: String((order && order.created_by) || ''),
				status_from: '待配货',
				status_to: String(statusTo || '已配货'),
				operator: String(operatorName || ''),
				channel: 'subscribe',
				sent: false,
				reason: res.reason,
				create_date: Date.now(),
			})
		} catch (e2) {
			// 双重失败仅放弃记录
		}
		return res
	}
}

module.exports = {
	notifyOrderAllocated,
}
