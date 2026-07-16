package io.xkeen.mobile.app

import org.json.JSONObject

/**
 * Adapter for the small mobile-v1 session contract. It deliberately keeps the
 * browser cookie and CSRF values out of UI state: only SessionMaterialStore sees
 * them, and only after the server has confirmed an authenticated session.
 */
internal class MobileSessionPort(
    private val sessionMaterials: SessionMaterialStore,
    private val transport: CompanionHttpTransport,
) : SessionPort {
    override suspend fun pair(connection: Connection): SessionPairResult {
        val bootstrap = loadBootstrap(connection.baseUrl)
        return if (bootstrap.authenticated) {
            SessionPairResult.Open(openResult(connection, bootstrap.user, restored = true))
        } else {
            val isSetupRequired = !bootstrap.configured
            SessionPairResult.Status(
                connection = connection.copy(
                    status = if (isSetupRequired) ConnectionStatus.SetupRequired else ConnectionStatus.NeedsAuth,
                    lastSeen = if (isSetupRequired) "Требуется первичная настройка" else "Требуется вход",
                ),
                statusSummary = if (isSetupRequired) "Требуется настройка Xkeen UI" else "Требуется вход",
                message = if (isSetupRequired) {
                    "На узле еще не создана учетная запись администратора. Завершите настройку в Xkeen UI."
                } else {
                    "Узел доступен. Введите учетные данные администратора для открытия мобильной сессии."
                },
            )
        }
    }

    override suspend fun login(connection: Connection, credentials: LoginForm): SessionOpenResult {
        require(credentials.username.isNotBlank()) { "Введите логин." }
        require(credentials.password.isNotBlank()) { "Введите пароль." }

        val response = try {
            transport.post(
                CompanionHttpRequest(
                    baseUrl = connection.baseUrl,
                    endpoint = "/api/mobile/v1/session",
                    body = credentials.toJsonBody(),
                    useAuthHook = false,
                ),
            )
        } catch (error: CompanionTransportException) {
            if (error.isLegacyMobileHandshakeFailure()) {
                return loginThroughWebApi(connection, credentials)
            }
            throw error
        }
        val payload = parseMobilePayload(response.body)
        val session = payload.optJSONObject("session")
            ?: throw MobileSessionException("Сервер не вернул параметры мобильной сессии.")
        val csrfToken = session.optString("csrf_token").trim()
            .takeIf(String::isNotBlank)
            ?: throw MobileSessionException("Сервер не вернул CSRF-параметр сессии.")
        val cookieHeader = response.setCookieHeaders.toCookieHeader()
            ?: throw MobileSessionException("Сервер не вернул cookie мобильной сессии.")

        saveTrustedSession(connection, cookieHeader, csrfToken)
        return openResult(
            connection = connection,
            user = session.optString("user").trim().ifBlank { credentials.username.trim() },
            restored = false,
        )
    }

    override suspend fun restore(connection: Connection): SessionRestoreResult {
        val stored = sessionMaterials.loadTrusted(connection.id) ?: return SessionRestoreResult.NotAvailable
        return try {
            val bootstrap = loadBootstrap(connection.baseUrl, stored.material)
            if (bootstrap.authenticated) {
                SessionRestoreResult.Open(openResult(connection, bootstrap.user, restored = true))
            } else {
                SessionRestoreResult.AuthRequired(expire(connection))
            }
        } catch (error: CompanionTransportException) {
            when (error.failure.kind) {
                CompanionTransportFailureKind.AuthenticationRequired,
                CompanionTransportFailureKind.AccessDenied,
                CompanionTransportFailureKind.SetupRequired,
                -> SessionRestoreResult.AuthRequired(expire(connection))

                else -> throw error
            }
        }
    }

    override suspend fun disconnect(connection: Connection): SessionCloseResult {
        val stored = sessionMaterials.load(connection.id)
        val localResult = expire(connection)
        if (stored == null) return localResult

        return try {
            transport.delete(
                CompanionHttpRequest(
                    baseUrl = connection.baseUrl,
                    endpoint = "/api/mobile/v1/session",
                    headers = stored.material.toSessionHeaders(),
                    useAuthHook = false,
                ),
            )
            localResult
        } catch (error: Exception) {
            if ((error as? CompanionTransportException)?.isLegacyMobileHandshakeFailure() == true) {
                runCatching {
                    transport.post(
                        CompanionHttpRequest(
                            baseUrl = connection.baseUrl,
                            endpoint = "/api/auth/logout",
                            headers = stored.material.toSessionHeaders(),
                            useAuthHook = false,
                        ),
                    )
                }
            }
            localResult.copy(
                statusSummary = "Сессия удалена с устройства",
                logMessage = "Локальная мобильная сессия удалена; сервер подтвердит выход при следующем подключении",
            )
        }
    }

    override fun expire(connection: Connection): SessionCloseResult {
        sessionMaterials.clear(connection.id)
        return SessionCloseResult(
            connection = connection.copy(
                status = ConnectionStatus.NeedsAuth,
                lastSeen = "Требуется повторный вход",
            ),
            statusSummary = "Требуется вход",
            logMessage = "Мобильная сессия закрыта",
        )
    }

    private suspend fun loadBootstrap(
        baseUrl: String,
        material: SessionMaterial? = null,
    ): MobileBootstrap = try {
        parseMobileBootstrap(
            transport.get(
                CompanionHttpRequest(
                    baseUrl = baseUrl,
                    endpoint = "/api/mobile/v1/bootstrap",
                    headers = material?.toSessionHeaders().orEmpty(),
                    useAuthHook = false,
                ),
            ).body,
        )
    } catch (error: CompanionTransportException) {
        if (error.isLegacyMobileHandshakeFailure()) {
            loadLegacyBootstrap(baseUrl, material)
        } else {
            throw error
        }
    }

    /**
     * Installations predating the mobile-v1 handshake still expose the browser JSON auth API.
     * Keep this adapter deliberately local to the session layer: UI state never sees the
     * temporary CSRF token, cookie, or password used for the compatibility login.
     */
    private suspend fun loginThroughWebApi(
        connection: Connection,
        credentials: LoginForm,
    ): SessionOpenResult {
        val loginPage = transport.get(
            CompanionHttpRequest(
                baseUrl = connection.baseUrl,
                endpoint = "/login",
                allowHtmlResponse = true,
                useAuthHook = false,
            ),
        )
        val initialCsrf = loginPage.body.extractCsrfToken()
        val initialCookie = loginPage.setCookieHeaders.toCookieHeader()
            ?: throw MobileSessionException("Xkeen UI не создал защищенную сессию для входа.")

        val loginResponse = transport.post(
            CompanionHttpRequest(
                baseUrl = connection.baseUrl,
                endpoint = "/api/auth/login",
                headers = mapOf(
                    "Cookie" to initialCookie,
                    "X-CSRF-Token" to initialCsrf,
                ),
                body = credentials.toJsonBody(),
                useAuthHook = false,
            ),
        )
        requireLegacyAuthSuccess(loginResponse.body)
        val authenticatedCookie = loginResponse.setCookieHeaders.toCookieHeader()
            ?: throw MobileSessionException("Xkeen UI не вернул cookie после входа.")

        val authenticatedPage = transport.get(
            CompanionHttpRequest(
                baseUrl = connection.baseUrl,
                endpoint = "/",
                headers = mapOf("Cookie" to authenticatedCookie),
                allowHtmlResponse = true,
                useAuthHook = false,
            ),
        )
        val authenticatedCsrf = authenticatedPage.body.extractCsrfToken()
        saveTrustedSession(connection, authenticatedCookie, authenticatedCsrf)
        return openResult(
            connection = connection,
            user = credentials.username.trim(),
            restored = false,
        )
    }

    private suspend fun loadLegacyBootstrap(
        baseUrl: String,
        material: SessionMaterial?,
    ): MobileBootstrap {
        val response = transport.get(
            CompanionHttpRequest(
                baseUrl = baseUrl,
                endpoint = "/api/auth/status",
                headers = material?.toSessionHeaders().orEmpty(),
                useAuthHook = false,
            ),
        )
        return parseLegacyBootstrap(response.body)
    }

    private fun saveTrustedSession(
        connection: Connection,
        cookieHeader: String,
        csrfToken: String,
    ) {
        sessionMaterials.save(
            StoredSessionMaterial(
                connectionId = connection.id,
                material = SessionMaterial(
                    cookieHeader = cookieHeader,
                    csrfToken = csrfToken,
                ),
                trustedForRestore = true,
            ),
        )
    }

    private fun openResult(
        connection: Connection,
        user: String?,
        restored: Boolean,
    ): SessionOpenResult = SessionOpenResult(
        connection = connection.copy(
            status = ConnectionStatus.Configured,
            lastSeen = if (restored) "Сессия восстановлена" else "Готово",
        ),
        statusSummary = "Готов к безопасному управлению",
        lastOperation = if (restored) "Мобильная сессия восстановлена" else "Вход выполнен",
        eventTitle = if (restored) "Сессия восстановлена" else "Вход выполнен",
        eventSubtitle = user?.takeIf(String::isNotBlank)?.let { "Авторизован: $it" }
            ?: "Сессия подтверждена Xkeen UI",
        logMessage = if (restored) {
            "Доверенная мобильная сессия подтверждена сервером"
        } else {
            "Открыта мобильная сессия Xkeen UI"
        },
    )
}

internal class SessionMaterialAuthHook(
    private val connections: ConnectionsPort,
    private val sessionMaterials: SessionMaterialStore,
) : CompanionHttpAuthHook {
    override fun headersFor(normalizedBaseUrl: String): Map<String, String> {
        val snapshot = connections.load()
        val connection = snapshot.selectedConnectionId
            ?.let { selectedId -> snapshot.connections.firstOrNull { it.id == selectedId } }
            ?: return emptyMap()
        if (
            runCatching { normalizeCompanionBaseUrl(connection.baseUrl).toString() }
                .getOrNull() != normalizedBaseUrl
        ) {
            return emptyMap()
        }
        return sessionMaterials.loadTrusted(connection.id)?.material?.toSessionHeaders().orEmpty()
    }
}

private data class MobileBootstrap(
    val configured: Boolean,
    val authenticated: Boolean,
    val user: String?,
)

private fun parseMobileBootstrap(body: String): MobileBootstrap {
    val data = parseMobilePayload(body)
    val auth = data.optJSONObject("auth")
        ?: throw MobileSessionException("Сервер не вернул состояние мобильной авторизации.")
    return MobileBootstrap(
        configured = auth.optBoolean("configured", false),
        authenticated = auth.optBoolean("authenticated", false),
        user = auth.optString("user").trim().takeIf(String::isNotBlank),
    )
}

private fun parseLegacyBootstrap(body: String): MobileBootstrap {
    val root = parseJsonObject(
        body = body,
        unexpectedMessage = "Xkeen UI вернул неожиданный ответ проверки авторизации.",
    )
    if (!root.optBoolean("ok", false)) {
        throw MobileSessionException("Xkeen UI отклонил проверку авторизации.")
    }
    return MobileBootstrap(
        configured = root.optBoolean("configured", false),
        authenticated = root.optBoolean("logged_in", false),
        user = root.optString("user").trim().takeIf(String::isNotBlank),
    )
}

private fun parseMobilePayload(body: String): JSONObject {
    val root = parseJsonObject(
        body = body,
        unexpectedMessage = "Xkeen UI вернул неожиданный ответ мобильной сессии.",
    )
    if (!root.optBoolean("ok", false)) {
        throw MobileSessionException("Xkeen UI отклонил запрос мобильной сессии.")
    }
    return root.optJSONObject("data")
        ?: throw MobileSessionException("Сервер не вернул данные мобильной сессии.")
}

private fun requireLegacyAuthSuccess(body: String) {
    val root = parseJsonObject(
        body = body,
        unexpectedMessage = "Xkeen UI вернул неожиданный ответ входа.",
    )
    if (!root.optBoolean("ok", false)) {
        val message = root.optString("message").trim().takeIf(String::isNotBlank)
            ?: "Xkeen UI отклонил вход."
        throw MobileSessionException(message)
    }
}

private fun parseJsonObject(body: String, unexpectedMessage: String): JSONObject = try {
    JSONObject(body)
} catch (error: Exception) {
    throw MobileSessionException(unexpectedMessage, error)
}

private fun LoginForm.toJsonBody(): String = JSONObject()
    .put("username", username.trim())
    .put("password", password)
    .toString()

private fun String.extractCsrfToken(): String {
    val patterns = listOf(
        Regex(
            """<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']""",
            RegexOption.IGNORE_CASE,
        ),
        Regex(
            """<input\s+type=["']hidden["']\s+name=["']csrf_token["']\s+value=["']([^"']+)["']""",
            RegexOption.IGNORE_CASE,
        ),
    )
    return patterns.firstNotNullOfOrNull { pattern ->
        pattern.find(this)?.groupValues?.getOrNull(1)?.trim()?.takeIf(String::isNotBlank)
    } ?: throw MobileSessionException("Xkeen UI не вернул CSRF-параметр для входа.")
}

private fun CompanionTransportException.isLegacyMobileHandshakeFailure(): Boolean =
    failure.statusCode == 404 || (
        failure.kind == CompanionTransportFailureKind.AuthenticationRequired &&
            failure.serverCode?.lowercase() in setOf(null, "unauthorized")
        )

private fun SessionMaterial.toSessionHeaders(): Map<String, String> = buildMap {
    accessToken?.takeIf(String::isNotBlank)?.let { put("Authorization", "Bearer $it") }
    cookieHeader?.takeIf(String::isNotBlank)?.let { put("Cookie", it) }
    csrfToken?.takeIf(String::isNotBlank)?.let { put("X-CSRF-Token", it) }
}

private fun List<String>.toCookieHeader(): String? = mapNotNull { header ->
    header.substringBefore(';').trim().takeIf(String::isNotBlank)
}.takeIf(List<String>::isNotEmpty)?.joinToString("; ")

internal class MobileSessionException(message: String, cause: Throwable? = null) :
    Exception(message, cause)
