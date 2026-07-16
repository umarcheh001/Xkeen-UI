package io.xkeen.mobile.app

import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.URI
import java.net.UnknownHostException
import java.nio.charset.StandardCharsets
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

internal data class CompanionHttpRequest(
    val baseUrl: String,
    val endpoint: String,
    val headers: Map<String, String> = emptyMap(),
    val body: String? = null,
    val allowHtmlResponse: Boolean = false,
    val useAuthHook: Boolean = true,
)

internal data class CompanionHttpResponse(
    val statusCode: Int,
    val body: String,
    val headers: Map<String, String>,
    val contentType: String,
    val setCookieHeaders: List<String> = emptyList(),
)

/**
 * The transport contract is deliberately successful-response-only. Callers receive a parsed
 * response or one [CompanionTransportException] with an app-level failure kind.
 */
internal interface CompanionHttpTransport {
    suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse

    suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse

    suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse
}

/**
 * Supplies session headers without coupling the transport to a particular auth implementation.
 * SessionMaterialAuthHook attaches the restored mobile session in the production composition.
 */
internal fun interface CompanionHttpAuthHook {
    fun headersFor(baseUrl: String): Map<String, String>
}

internal data class CompanionHttpTransportConfig(
    val connectTimeoutMillis: Int = 5_000,
    val readTimeoutMillis: Int = 10_000,
    val commonHeaders: Map<String, String> = defaultCompanionHttpHeaders,
)

internal val defaultCompanionHttpHeaders: Map<String, String> = mapOf(
    "Accept" to "application/json, text/plain;q=0.9",
    "Cache-Control" to "no-cache",
    "X-Requested-With" to "XkeenMobileCompanion",
)

internal object NoOpCompanionHttpAuthHook : CompanionHttpAuthHook {
    override fun headersFor(baseUrl: String): Map<String, String> = emptyMap()
}

internal class HttpUrlConnectionCompanionTransport(
    private val config: CompanionHttpTransportConfig = CompanionHttpTransportConfig(),
    private val authHook: CompanionHttpAuthHook = NoOpCompanionHttpAuthHook,
) : CompanionHttpTransport {
    override suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse =
        execute("GET", request)

    override suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse =
        execute("POST", request)

    override suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse =
        execute("DELETE", request)

    private suspend fun execute(
        method: String,
        request: CompanionHttpRequest,
    ): CompanionHttpResponse =
        withContext(Dispatchers.IO) {
            val url = resolveCompanionEndpoint(request.baseUrl, request.endpoint)
            try {
                val connection = url.toURL().openConnection() as HttpURLConnection
                try {
                    connection.requestMethod = method
                    connection.connectTimeout = config.connectTimeoutMillis
                    connection.readTimeout = config.readTimeoutMillis
                    connection.useCaches = false
                    connection.instanceFollowRedirects = true
                    val headers = mergedCompanionHeaders(config, authHook, request)
                    headers.forEach { (name, value) ->
                        connection.setRequestProperty(name, value)
                    }
                    request.body?.let { body ->
                        connection.doOutput = true
                        if (headers.keys.none { it.equals("Content-Type", ignoreCase = true) }) {
                            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                        }
                        connection.outputStream.bufferedWriter(StandardCharsets.UTF_8).use { writer ->
                            writer.write(body)
                        }
                    }

                    val status = connection.responseCode
                    val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                    val response = CompanionHttpResponse(
                        statusCode = status,
                        body = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty(),
                        headers = connection.headerFields
                            .filterKeys { it != null }
                            .mapKeys { (name, _) -> name.orEmpty().lowercase() }
                            .mapValues { (_, values) -> values?.firstOrNull().orEmpty() },
                        contentType = connection.contentType.orEmpty(),
                        setCookieHeaders = connection.headerFields
                            .entries
                            .filter { (name, _) -> name.equals("Set-Cookie", ignoreCase = true) }
                            .flatMap { (_, values) -> values.orEmpty() },
                    )
                    requireSuccessfulCompanionResponse(
                        response = response,
                        allowHtmlResponse = request.allowHtmlResponse,
                    )
                } finally {
                    connection.disconnect()
                }
            } catch (error: CompanionTransportException) {
                throw error
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                throw error.toCompanionTransportException()
            }
        }
}

internal enum class CompanionTransportFailureKind {
    InvalidBaseUrl,
    AuthenticationRequired,
    AccessDenied,
    SetupRequired,
    Offline,
    Timeout,
    ServerError,
    HttpError,
    UnexpectedResponse,
}

internal data class CompanionTransportFailure(
    val kind: CompanionTransportFailureKind,
    val userMessage: String,
    val statusCode: Int? = null,
    val serverCode: String? = null,
)

internal class CompanionTransportException(
    val failure: CompanionTransportFailure,
    cause: Throwable? = null,
) : Exception(failure.userMessage, cause)

internal fun mergedCompanionHeaders(
    config: CompanionHttpTransportConfig,
    authHook: CompanionHttpAuthHook,
    request: CompanionHttpRequest,
): Map<String, String> = buildMap {
    putNormalizedHeaders(config.commonHeaders)
    putNormalizedHeaders(request.headers)
    if (request.useAuthHook) {
        putNormalizedHeaders(authHook.headersFor(normalizeCompanionBaseUrl(request.baseUrl).toString()))
    }
}

private fun MutableMap<String, String>.putNormalizedHeaders(headers: Map<String, String>) {
    headers.forEach { (name, value) ->
        val normalizedName = name.trim()
        val normalizedValue = value.trim()
        if (normalizedName.isNotEmpty() && normalizedValue.isNotEmpty()) {
            val existing = keys.firstOrNull { it.equals(normalizedName, ignoreCase = true) }
            if (existing != null) remove(existing)
            put(normalizedName, normalizedValue)
        }
    }
}

internal fun requireSuccessfulCompanionResponse(
    response: CompanionHttpResponse,
    allowHtmlResponse: Boolean = false,
): CompanionHttpResponse {
    val serverError = if (response.statusCode in 200..299) {
        CompanionServerError()
    } else {
        response.parseServerError()
    }
    val failure = when {
        response.statusCode == HttpURLConnection.HTTP_UNAUTHORIZED -> CompanionTransportFailure(
            kind = CompanionTransportFailureKind.AuthenticationRequired,
            userMessage = serverError.message ?: "Требуется вход в Xkeen UI.",
            statusCode = response.statusCode,
            serverCode = serverError.code,
        )

        response.statusCode == HttpURLConnection.HTTP_FORBIDDEN -> CompanionTransportFailure(
            kind = CompanionTransportFailureKind.AccessDenied,
            userMessage = serverError.message
                ?: "У текущей сессии нет доступа к этому разделу Xkeen UI.",
            statusCode = response.statusCode,
            serverCode = serverError.code,
        )

        response.statusCode == 428 -> CompanionTransportFailure(
            kind = CompanionTransportFailureKind.SetupRequired,
            userMessage = serverError.message
                ?: "На Xkeen UI нужно завершить начальную настройку.",
            statusCode = response.statusCode,
            serverCode = serverError.code,
        )

        response.statusCode !in 200..299 -> CompanionTransportFailure(
            kind = if (response.statusCode in 500..599) {
                CompanionTransportFailureKind.ServerError
            } else {
                CompanionTransportFailureKind.HttpError
            },
            userMessage = if (response.statusCode in 500..599) {
                "Xkeen UI временно не может обработать запрос. Попробуйте ещё раз."
            } else {
                serverError.message ?: "Xkeen UI вернул ошибку HTTP ${response.statusCode}."
            },
            statusCode = response.statusCode,
            serverCode = serverError.code,
        )

        response.isHtmlResponse() && !allowHtmlResponse -> CompanionTransportFailure(
            kind = CompanionTransportFailureKind.AuthenticationRequired,
            userMessage = "Xkeen UI вернул страницу входа. Требуется авторизация.",
            statusCode = response.statusCode,
        )

        else -> null
    }
    if (failure != null) throw CompanionTransportException(failure)
    return response
}

private data class CompanionServerError(
    val code: String? = null,
    val message: String? = null,
)

private fun CompanionHttpResponse.parseServerError(): CompanionServerError {
    if (body.isBlank()) return CompanionServerError()
    return runCatching {
        val root = JSONObject(body)
        val errorValue = root.opt("error")
        val errorObject = errorValue as? JSONObject
        CompanionServerError(
            code = when (errorValue) {
                is JSONObject -> errorValue.optString("code").trim().takeIf(String::isNotBlank)
                is String -> errorValue.trim().takeIf(String::isNotBlank)
                else -> null
            },
            message = errorObject?.optString("message")?.trim()?.takeIf(String::isNotBlank)
                ?: root.optString("message").trim().takeIf(String::isNotBlank),
        )
    }.getOrDefault(CompanionServerError())
}

private fun CompanionHttpResponse.isHtmlResponse(): Boolean {
    val mimeType = contentType.substringBefore(';').trim()
    if (
        mimeType.equals("text/html", ignoreCase = true) ||
        mimeType.equals("application/xhtml+xml", ignoreCase = true)
    ) {
        return true
    }
    val leadingBody = body.trimStart()
    return leadingBody.startsWith("<!doctype html", ignoreCase = true) ||
        leadingBody.startsWith("<html", ignoreCase = true)
}

internal fun resolveCompanionEndpoint(baseUrl: String, endpoint: String): URI {
    val base = normalizeCompanionBaseUrl(baseUrl)
    val endpointValue = endpoint.trim()
    if (endpointValue.isBlank()) {
        throw invalidBaseUrl("Не указан путь запроса Xkeen UI.")
    }
    val endpointUri = try {
        URI.create(endpointValue)
    } catch (error: IllegalArgumentException) {
        throw invalidBaseUrl("Некорректный путь запроса Xkeen UI.", error)
    }
    if (
        endpointUri.isAbsolute ||
        endpointUri.rawAuthority != null ||
        endpointUri.rawFragment != null ||
        endpointUri.rawPath.orEmpty().split('/').any { it == ".." }
    ) {
        throw invalidBaseUrl("Некорректный путь запроса Xkeen UI.")
    }

    val baseRoot = URI.create("${base.toString().trimEnd('/')}/")
    val resolved = baseRoot.resolve(endpointUri.toString().trimStart('/')).normalize()
    val basePath = base.rawPath.orEmpty().trimEnd('/')
    if (basePath.isNotEmpty() && !resolved.rawPath.orEmpty().startsWith("$basePath/")) {
        throw invalidBaseUrl("Путь запроса выходит за пределы адреса Xkeen UI.")
    }
    return resolved
}

internal fun normalizeCompanionBaseUrl(baseUrl: String): URI {
    val value = baseUrl.trim()
    if (value.isBlank()) throw invalidBaseUrl("Не указан адрес Xkeen UI.")

    val parsed = try {
        URI.create(value)
    } catch (error: IllegalArgumentException) {
        throw invalidBaseUrl("Некорректный адрес Xkeen UI.", error)
    }
    val scheme = parsed.scheme?.lowercase() ?: throw invalidBaseUrl("Некорректный адрес Xkeen UI.")
    val host = parsed.host?.takeIf { it.isNotBlank() }
    if (
        scheme !in setOf("http", "https") ||
        host == null ||
        parsed.rawUserInfo != null ||
        parsed.rawQuery != null ||
        parsed.rawFragment != null
    ) {
        throw invalidBaseUrl("Некорректный адрес Xkeen UI.")
    }
    return try {
        URI(scheme, null, host, parsed.port, parsed.path.orEmpty().trimEnd('/'), null, null)
    } catch (error: Exception) {
        throw invalidBaseUrl("Некорректный адрес Xkeen UI.", error)
    }
}

internal fun Throwable.toCompanionTransportException(): CompanionTransportException {
    val failure = when (this) {
        is SocketTimeoutException -> CompanionTransportFailure(
            CompanionTransportFailureKind.Timeout,
            "Xkeen UI не ответил вовремя. Проверьте сеть и повторите запрос.",
        )

        is UnknownHostException,
        is ConnectException,
        is NoRouteToHostException,
        is SocketException,
        -> CompanionTransportFailure(
            CompanionTransportFailureKind.Offline,
            "Не удалось подключиться к Xkeen UI. Проверьте адрес, сеть или VPN.",
        )

        else -> CompanionTransportFailure(
            CompanionTransportFailureKind.UnexpectedResponse,
            "Не удалось выполнить запрос к Xkeen UI. Попробуйте ещё раз.",
        )
    }
    return CompanionTransportException(failure, this)
}

private fun invalidBaseUrl(message: String, cause: Throwable? = null): CompanionTransportException =
    CompanionTransportException(
        CompanionTransportFailure(
            kind = CompanionTransportFailureKind.InvalidBaseUrl,
            userMessage = message,
        ),
        cause,
    )
