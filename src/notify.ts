import type { NotifyChannel, SubscriptionRow } from "./types.js";

// We don't use the normalizeTokenForChannel from db.ts here,
// because we want to test the raw token/URL provided by the user.
function getWebhookUrl(channel: NotifyChannel, token: string): string {
    if (/^https?:\]/i.test(token)) {
        return token;
    }
    switch (channel) {
        case "wxwork":
            return `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${token}`;
        case "feishu":
            return `https://open.feishu.cn/open-apis/bot/v2/hook/${token}`;
        case "serverchan":
            return `https://sctapi.ftqq.com/${token}.send`;
        default:
            throw new Error("Unsupported channel");
    }
}

function getPayload(channel: NotifyChannel, title: string, body: string) {
    switch (channel) {
        case "wxwork":
            return {
                msgtype: "text",
                text: { content: `${title}\n\n${body}` },
            };
        case "feishu":
            return {
                msg_type: "text",
                content: { text: `${title}\n${body}` },
            };
        case "serverchan":
            // ServerChan uses form data for GET, but supports JSON for POST
            return {
                title: title,
                desp: body,
            };
        default:
            return {};
    }
}

async function sendMessage(
    channel: NotifyChannel,
    token: string,
    title: string,
    body: string
): Promise<{ ok: boolean; error?: string }> {
    if (channel === "none" || !token) {
        return {
            ok: false,
            error: "Channel is set to none or token is missing.",
        };
    }

    const url = getWebhookUrl(channel, token);
    const payload = getPayload(channel, title, body);

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        type WebhookResult =
            | { code: number; msg: string } // Feishu
            | { errcode: number; errmsg: string } // WxWork
            | { code: number; message: string }; // ServerChan

        function normalizeResult(
            channel: string,
            result: any
        ): { code: number; msg: string } {
            switch (channel) {
                case "feishu":
                    return { code: result.code, msg: result.msg };
                case "wxwork":
                    return { code: result.errcode, msg: result.errmsg };
                case "serverchan":
                    return { code: result.code, msg: result.message };
                default:
                    return { code: -1, msg: "Unknown channel" };
            }
        }

        const result = (await response.json()) as WebhookResult;
        const normalized = normalizeResult(channel, result);

        if (!response.ok || normalized.code !== 0) {
            console.error(`Webhook for ${channel} reported an error:`, result);
            return {
                ok: false,
                error: `Notify API error(${normalized.code}): ${normalized.msg}`,
            };
        }

        return { ok: true };
    } catch (e: any) {
        console.error(`Error sending message for ${channel}:`, e);
        return { ok: false, error: e.message || "An unknown error occurred." };
    }
}

export async function sendTestNotification(
    channel: NotifyChannel,
    token: string,
    canonical_id: string
): Promise<{ ok: boolean; error?: string }> {
    const testTitle = "Dormitricity 通知测试";
    const testBody =
        `正在为宿舍 ${canonical_id} 配置提醒。这是一条测试消息，用于验证您的通知配置是否正常工作。`;
    
    return await sendMessage(channel, token, testTitle, testBody);
}

export async function sendAlert(
    sub: SubscriptionRow,
    reason: "low_power" | "depletion_imminent",
    details: { hours_remaining?: number }
): Promise<{ ok: boolean; error?: string }> {
    let title = "";
    let body = "";

    if (reason === "low_power") {
        title = "Dormitricity: 低电量提醒";
        body = `宿舍 ${sub.canonical_id} 当前剩余电量 ${sub.last_kwh!.toFixed(2)} kWh，已低于您设置的 ${sub.threshold_kwh} kWh 阈值。`;
    } else if (reason === "depletion_imminent") {
        title = "Dormitricity: 即将耗尽提醒";
        body = `宿舍 ${sub.canonical_id} 当前剩余电量 ${sub.last_kwh!.toFixed(2)} kWh，预计将在 ${details.hours_remaining!.toFixed(1)} 小时内用尽，已低于 ${sub.within_hours} 小时阈值。`;
    } else {
        return { ok: false, error: "Unknown alert reason" };
    }

    if (!sub.notify_token) {
        return { ok: false, error: "Notification token is not configured." };
    }

    return await sendMessage(sub.notify_channel, sub.notify_token, title, body);
}