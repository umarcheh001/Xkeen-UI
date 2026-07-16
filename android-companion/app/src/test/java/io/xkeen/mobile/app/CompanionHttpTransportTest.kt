package io.xkeen.mobile.app

import java.net.ConnectException
import java.net.SocketTimeoutException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionHttpTransportTest {
    @Test
    fun normalizesBaseUrlAndKeepsAnOptionalBasePath() {
        val endpoint = resolveCompanionEndpoint(
            baseUrl = " HTTPS://lab.lan:8443/xkeen/ ",
            endpoint = "/api/routing/fragments",
        )

        assertEquals("https://lab.lan:8443/xkeen/api/routing/fragments", endpoint.toString())
        assertEquals("https://lab.lan:8443/xkeen", normalizeCompanionBaseUrl("https://lab.lan:8443/xkeen/").toString())
    }

    @Test
    fun rejectsUnsafeOrIncompleteBaseAndEndpointUrls() {
        val missingScheme = assertTransportFailure {
            resolveCompanionEndpoint("lab.lan:8443", "/api/xkeen/core")
        }
        val queryInBase = assertTransportFailure {
            resolveCompanionEndpoint("https://lab.lan?next=/login", "/api/xkeen/core")
        }
        val escapingEndpoint = assertTransportFailure {
            resolveCompanionEndpoint("https://lab.lan/xkeen", "../api/xkeen/core")
        }

        assertEquals(CompanionTransportFailureKind.InvalidBaseUrl, missingScheme.failure.kind)
        assertEquals(CompanionTransportFailureKind.InvalidBaseUrl, queryInBase.failure.kind)
        assertEquals(CompanionTransportFailureKind.InvalidBaseUrl, escapingEndpoint.failure.kind)
    }

    @Test
    fun classifiesAuthSetupAndServerResponsesBeforeSourcesParseThem() {
        val unauthorized = assertTransportFailure {
            requireSuccessfulCompanionResponse(
                response(
                    statusCode = 401,
                    body = """{"ok":false,"error":{"code":"invalid_credentials","message":"Неверный логин или пароль. Осталось попыток: 4."}}""",
                ),
            )
        }
        val forbidden = assertTransportFailure {
            requireSuccessfulCompanionResponse(response(statusCode = 403))
        }
        val setupRequired = assertTransportFailure {
            requireSuccessfulCompanionResponse(response(statusCode = 428))
        }
        val serverError = assertTransportFailure {
            requireSuccessfulCompanionResponse(response(statusCode = 503))
        }
        val htmlLogin = assertTransportFailure {
            requireSuccessfulCompanionResponse(
                response(statusCode = 200, body = "<!doctype html><html><body>Login</body></html>"),
            )
        }

        assertEquals(CompanionTransportFailureKind.AuthenticationRequired, unauthorized.failure.kind)
        assertEquals("invalid_credentials", unauthorized.failure.serverCode)
        assertEquals(
            "Неверный логин или пароль. Осталось попыток: 4.",
            unauthorized.failure.userMessage,
        )
        assertEquals(CompanionTransportFailureKind.AccessDenied, forbidden.failure.kind)
        assertEquals(CompanionTransportFailureKind.SetupRequired, setupRequired.failure.kind)
        assertEquals(CompanionTransportFailureKind.ServerError, serverError.failure.kind)
        assertEquals(CompanionTransportFailureKind.AuthenticationRequired, htmlLogin.failure.kind)
    }

    @Test
    fun allowsHtmlOnlyForAnExplicitCompatibilityRequest() {
        val html = response(
            statusCode = 200,
            body = """<!doctype html><meta name="csrf-token" content="token">""",
        ).copy(contentType = "text/html")

        assertEquals(html, requireSuccessfulCompanionResponse(html, allowHtmlResponse = true))
    }

    @Test
    fun classifiesTimeoutAndOfflineCauses() {
        val timeout = SocketTimeoutException("slow").toCompanionTransportException()
        val offline = ConnectException("refused").toCompanionTransportException()

        assertEquals(CompanionTransportFailureKind.Timeout, timeout.failure.kind)
        assertEquals(CompanionTransportFailureKind.Offline, offline.failure.kind)
    }

    @Test
    fun mergesCommonRequestAndAuthHeadersWithAuthTakingPrecedence() {
        val hookBases = mutableListOf<String>()
        val headers = mergedCompanionHeaders(
            config = CompanionHttpTransportConfig(
                commonHeaders = mapOf(
                    "Accept" to "application/json",
                    "X-Requested-With" to "Companion",
                ),
            ),
            authHook = CompanionHttpAuthHook { normalizedBaseUrl ->
                hookBases += normalizedBaseUrl
                mapOf(
                    "Authorization" to "Bearer restored-session",
                    "X-Requested-With" to "AuthenticatedCompanion",
                )
            },
            request = CompanionHttpRequest(
                baseUrl = "https://lab.lan:8443/panel/",
                endpoint = "/api/xkeen/core",
                headers = mapOf(
                    "accept" to "application/problem+json",
                    "authorization" to "Bearer caller-value",
                ),
            ),
        )

        assertEquals("application/problem+json", headers["accept"])
        assertEquals("Bearer restored-session", headers["Authorization"])
        assertEquals("AuthenticatedCompanion", headers["X-Requested-With"])
        assertEquals(listOf("https://lab.lan:8443/panel"), hookBases)
        assertTrue(headers.keys.none { it.equals("Accept", ignoreCase = true) && it != "accept" })
    }

    @Test
    fun explicitHandshakeRequestCanBypassStoredAuthHook() {
        var hookCalled = false
        val headers = mergedCompanionHeaders(
            config = CompanionHttpTransportConfig(commonHeaders = mapOf("Accept" to "application/json")),
            authHook = CompanionHttpAuthHook {
                hookCalled = true
                mapOf("Cookie" to "session=stale")
            },
            request = CompanionHttpRequest(
                baseUrl = "https://lab.lan",
                endpoint = "/api/auth/login",
                headers = mapOf("Cookie" to "session=temporary"),
                useAuthHook = false,
            ),
        )

        assertEquals("session=temporary", headers["Cookie"])
        assertTrue(!hookCalled)
    }

    private fun response(
        statusCode: Int,
        body: String = "{}",
    ): CompanionHttpResponse = CompanionHttpResponse(
        statusCode = statusCode,
        body = body,
        headers = emptyMap(),
        contentType = "application/json",
    )
}

private inline fun assertTransportFailure(block: () -> Unit): CompanionTransportException =
    try {
        block()
        throw AssertionError("Expected CompanionTransportException")
    } catch (error: CompanionTransportException) {
        error
    }
