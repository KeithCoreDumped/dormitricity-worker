import type { NotifyChannel } from "./types.js";

// We don't use the normalizeTokenForChannel from db.ts here,
// because we want to test the raw token/URL provided by the user.
function getWebhookUrl(channel: NotifyChannel, token: string): string {
    if (/^https?:\/\//i.test(token)) {
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

export async function sendTestNotification(
    channel: NotifyChannel,
    token: string
): Promise<{ ok: boolean; error?: string }> {
    if (channel === "none" || !token) {
        return {
            ok: false,
            error: "Channel is set to none or token is missing.",
        };
    }

    const url = getWebhookUrl(channel, token);
    const testTitle = "Dormitricity 通知测试";
    const testBody =
        "【宿舍电费】这是一条来自 Dormitricity 的测试消息。如果您收到此消息，说明您的通知设置已生效。";

    const payload = getPayload(channel, testTitle, testBody);

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

        // if (!response.ok) {
        //     const errorBody = await response.text();
        //     console.error(
        //         `Webhook failed for ${channel} with status ${response.status}: ${errorBody}`
        //     );
        //     return {
        //         ok: false,
        //         error: `Webhook request failed with status ${response.status}. Response: ${errorBody}`,
        //     };
        // }

        const result = (await response.json()) as WebhookResult;
        const normalized = normalizeResult(channel, result);

        if (!response.ok || normalized.code !== 0) {
            console.error(`Webhook for ${channel} reported an error:`, result);
            return {
                ok: false,
                error: `Notify API error(${normalized.code}): ${normalized.msg}`,
            };
        }

        // // Some webhooks might return a success status but have an error code in the body.
        // const result = (await response.json()) as {
        //     msg?: string;
        //     errmsg?: string;
        //     message?: string;
        //     errcode?: number;
        //     code?: number;
        // };
        // // Feishu: { code: 0, msg: "success" }
        // // WxWork: { errcode: 0, errmsg: "ok" }
        // // ServerChan: { code: 0, message: "" }
        // if (
        //     (channel === "feishu" && result.code !== 0) ||
        //     (channel === "wxwork" && result.errcode !== 0) ||
        //     (channel === "serverchan" && result.code !== 0)
        // ) {
        //     console.error(`Webhook for ${channel} reported an error:`, result);
        //     return {
        //         ok: false,
        //         error: `Webhook reported an error: ${JSON.stringify(result)}`,
        //     };
        // }

        return { ok: true };
    } catch (e: any) {
        console.error(`Error sending test notification for ${channel}:`, e);
        return { ok: false, error: e.message || "An unknown error occurred." };
    }
}
