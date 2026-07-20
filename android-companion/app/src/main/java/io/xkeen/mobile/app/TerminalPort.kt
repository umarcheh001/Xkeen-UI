package io.xkeen.mobile.app

import java.net.URI
import org.json.JSONObject

internal data class PtyConnectionSpec(
    val webSocketUrl: String,
    val sessionId: String? = null,
    val lastSequence: Long = 0,
    val columns: Int = 80,
    val rows: Int = 24,
)

internal interface TerminalPort {
    suspend fun issueConnection(
        baseUrl: String,
        sessionId: String?,
        lastSequence: Long,
        columns: Int,
        rows: Int,
    ): PtyConnectionSpec
}

internal class WebPanelTerminalPort(
    private val transport: CompanionHttpTransport,
) : TerminalPort {
    override suspend fun issueConnection(
        baseUrl: String,
        sessionId: String?,
        lastSequence: Long,
        columns: Int,
        rows: Int,
    ): PtyConnectionSpec {
        val response = transport.post(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = "/api/ws-token",
                body = JSONObject().put("scope", "pty").toString(),
            ),
        )
        val root = try {
            JSONObject(response.body)
        } catch (error: Exception) {
            throw TerminalConnectionException("Xkeen UI вернул неожиданный ответ для терминала.")
        }
        val token = root.optString("token").trim()
        if (!root.optBoolean("ok", false) || token.isBlank()) {
            throw TerminalConnectionException("Xkeen UI не выдал одноразовый токен терминала.")
        }

        val endpoint = resolveCompanionEndpoint(baseUrl, "/ws/pty")
        val wsScheme = if (endpoint.scheme.equals("https", ignoreCase = true)) "wss" else "ws"
        val query = buildList {
            add("token=${token.urlQueryValue()}")
            sessionId?.trim()?.takeIf(String::isNotBlank)?.let { add("session_id=${it.urlQueryValue()}") }
            add("last_seq=${lastSequence.coerceAtLeast(0)}")
            add("cols=${columns.coerceIn(2, 500)}")
            add("rows=${rows.coerceIn(1, 300)}")
        }.joinToString("&")
        val wsUri = URI(
            wsScheme,
            endpoint.rawUserInfo,
            endpoint.host,
            endpoint.port,
            endpoint.rawPath,
            query,
            null,
        )
        return PtyConnectionSpec(
            webSocketUrl = wsUri.toASCIIString(),
            sessionId = sessionId,
            lastSequence = lastSequence.coerceAtLeast(0),
            columns = columns.coerceIn(2, 500),
            rows = rows.coerceIn(1, 300),
        )
    }
}

internal class TerminalConnectionException(message: String) : Exception(message)

private fun String.urlQueryValue(): String = java.net.URLEncoder.encode(this, Charsets.UTF_8.name())
