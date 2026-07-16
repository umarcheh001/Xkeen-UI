package io.xkeen.mobile.app

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileSessionPortTest {
    private val connection = Connection(
        id = "home-node",
        name = "Домашний узел",
        baseUrl = "https://home.lan:8443",
        status = ConnectionStatus.NeedsAuth,
        lastSeen = "Требуется вход",
    )

    @Test
    fun loginStoresOnlyTrustedCookieAndCsrfMaterial() = runTest {
        val materials = InMemorySessionMaterialStore()
        val transport = RecordingSessionTransport(
            postResponse = response(
                body = """{"ok":true,"data":{"session":{"user":"admin","csrf_token":"csrf-123"}}}""",
                cookies = listOf("session=mobile-cookie; HttpOnly", "ignored=value; Path=/"),
            ),
        )
        val session = MobileSessionPort(materials, transport)

        val opened = session.login(connection, LoginForm(username = "admin", password = "secret"))

        assertEquals(ConnectionStatus.Configured, opened.connection.status)
        assertEquals("/api/mobile/v1/session", transport.postRequests.single().endpoint)
        assertTrue(transport.postRequests.single().body.orEmpty().contains("\"username\":\"admin\""))
        assertEquals(
            StoredSessionMaterial(
                connectionId = connection.id,
                material = SessionMaterial(
                    cookieHeader = "session=mobile-cookie; ignored=value",
                    csrfToken = "csrf-123",
                ),
                trustedForRestore = true,
            ),
            materials.loadTrusted(connection.id),
        )
    }

    @Test
    fun pairFallsBackToWebAuthStatusWhenMobileHandshakeIsProtectedByOlderServer() = runTest {
        val transport = ScriptedSessionTransport(
            getSteps = listOf(
                { throw legacyHandshakeFailure() },
                {
                    response(
                        body = """{"ok":true,"configured":true,"logged_in":false,"user":null}""",
                    )
                },
            ),
        )

        val result = MobileSessionPort(InMemorySessionMaterialStore(), transport).pair(connection)

        assertTrue(result is SessionPairResult.Status)
        assertEquals(ConnectionStatus.NeedsAuth, (result as SessionPairResult.Status).connection.status)
        assertEquals(
            listOf("/api/mobile/v1/bootstrap", "/api/auth/status"),
            transport.getRequests.map(CompanionHttpRequest::endpoint),
        )
        assertTrue(transport.getRequests.all { !it.useAuthHook })
    }

    @Test
    fun loginFallsBackToCsrfProtectedWebApiAndStoresAuthenticatedSession() = runTest {
        val materials = InMemorySessionMaterialStore()
        val transport = ScriptedSessionTransport(
            getSteps = listOf(
                {
                    response(
                        body = """<meta name="csrf-token" content="csrf-before">""",
                        cookies = listOf("session=anonymous-cookie; HttpOnly; Path=/"),
                    )
                },
                {
                    response(
                        body = """<meta name="csrf-token" content="csrf-after">""",
                    )
                },
            ),
            postSteps = listOf(
                { throw legacyHandshakeFailure() },
                {
                    response(
                        body = """{"ok":true}""",
                        cookies = listOf("session=authenticated-cookie; HttpOnly; Path=/"),
                    )
                },
            ),
        )

        val opened = MobileSessionPort(materials, transport).login(
            connection,
            LoginForm(username = "admin", password = "secret"),
        )

        assertEquals(ConnectionStatus.Configured, opened.connection.status)
        assertEquals(
            listOf("/api/mobile/v1/session", "/api/auth/login"),
            transport.postRequests.map(CompanionHttpRequest::endpoint),
        )
        assertEquals(listOf("/login", "/"), transport.getRequests.map(CompanionHttpRequest::endpoint))
        val legacyLogin = transport.postRequests.last()
        assertEquals("session=anonymous-cookie", legacyLogin.headers["Cookie"])
        assertEquals("csrf-before", legacyLogin.headers["X-CSRF-Token"])
        assertTrue(legacyLogin.body.orEmpty().contains("\"password\":\"secret\""))
        assertTrue(transport.getRequests.all(CompanionHttpRequest::allowHtmlResponse))
        assertTrue((transport.getRequests + transport.postRequests).all { !it.useAuthHook })
        assertEquals(
            StoredSessionMaterial(
                connectionId = connection.id,
                material = SessionMaterial(
                    cookieHeader = "session=authenticated-cookie",
                    csrfToken = "csrf-after",
                ),
                trustedForRestore = true,
            ),
            materials.loadTrusted(connection.id),
        )
    }

    @Test
    fun explicitMobileCredentialFailureDoesNotRetryAgainstWebApi() = runTest {
        val transport = ScriptedSessionTransport(
            postSteps = listOf(
                {
                    throw CompanionTransportException(
                        CompanionTransportFailure(
                            kind = CompanionTransportFailureKind.AuthenticationRequired,
                            userMessage = "Неверный логин или пароль.",
                            statusCode = 401,
                            serverCode = "invalid_credentials",
                        ),
                    )
                },
            ),
        )

        val error = runCatching {
            MobileSessionPort(InMemorySessionMaterialStore(), transport).login(
                connection,
                LoginForm(username = "admin", password = "wrong"),
            )
        }.exceptionOrNull()

        assertTrue(error is CompanionTransportException)
        assertEquals(listOf("/api/mobile/v1/session"), transport.postRequests.map(CompanionHttpRequest::endpoint))
        assertTrue(transport.getRequests.isEmpty())
    }

    @Test
    fun restoreConfirmsTrustedSessionWithItsOwnCookieAndCsrf() = runTest {
        val materials = trustedMaterials()
        val transport = RecordingSessionTransport(
            getResponse = response(
                body = """{"ok":true,"data":{"auth":{"configured":true,"authenticated":true,"user":"admin"}}}""",
            ),
        )

        val restored = MobileSessionPort(materials, transport).restore(connection)

        assertTrue(restored is SessionRestoreResult.Open)
        assertEquals("/api/mobile/v1/bootstrap", transport.getRequests.single().endpoint)
        assertEquals("session=mobile-cookie", transport.getRequests.single().headers["Cookie"])
        assertEquals("csrf-123", transport.getRequests.single().headers["X-CSRF-Token"])
        assertEquals("session=mobile-cookie", materials.loadTrusted(connection.id)?.material?.cookieHeader)
    }

    @Test
    fun unauthenticatedRestoreClearsOnlyExpiredMaterialAndRequiresLogin() = runTest {
        val materials = trustedMaterials()
        val transport = RecordingSessionTransport(
            getResponse = response(
                body = """{"ok":true,"data":{"auth":{"configured":true,"authenticated":false}}}""",
            ),
        )

        val restored = MobileSessionPort(materials, transport).restore(connection)

        assertTrue(restored is SessionRestoreResult.AuthRequired)
        assertNull(materials.load(connection.id))
    }

    @Test
    fun logoutSendsStoredCsrfAndAlwaysClearsLocalMaterial() = runTest {
        val materials = trustedMaterials()
        val transport = RecordingSessionTransport(deleteResponse = response(body = """{"ok":true,"data":{"session":{"closed":true}}}"""))

        val closed = MobileSessionPort(materials, transport).disconnect(connection)

        assertEquals(ConnectionStatus.NeedsAuth, closed.connection.status)
        assertEquals("/api/mobile/v1/session", transport.deleteRequests.single().endpoint)
        assertEquals("session=mobile-cookie", transport.deleteRequests.single().headers["Cookie"])
        assertEquals("csrf-123", transport.deleteRequests.single().headers["X-CSRF-Token"])
        assertNull(materials.load(connection.id))
    }

    @Test
    fun authHookUsesOnlyTheSelectedConnectionForMatchingBaseUrl() {
        val duplicate = connection.copy(id = "duplicate", name = "Другой профиль")
        val connections = InMemoryConnectionsPort(
            StoredConnections(
                connections = listOf(duplicate, connection),
                selectedConnectionId = connection.id,
            ),
        )
        val materials = InMemorySessionMaterialStore(
            listOf(
                StoredSessionMaterial(
                    connectionId = duplicate.id,
                    material = SessionMaterial(cookieHeader = "session=wrong"),
                    trustedForRestore = true,
                ),
                StoredSessionMaterial(
                    connectionId = connection.id,
                    material = SessionMaterial(cookieHeader = "session=selected"),
                    trustedForRestore = true,
                ),
            ),
        )
        val hook = SessionMaterialAuthHook(connections, materials)

        assertEquals(
            "session=selected",
            hook.headersFor("https://home.lan:8443")["Cookie"],
        )
        assertTrue(hook.headersFor("https://other.lan").isEmpty())
    }

    private fun trustedMaterials(): InMemorySessionMaterialStore = InMemorySessionMaterialStore(
        listOf(
            StoredSessionMaterial(
                connectionId = connection.id,
                material = SessionMaterial(
                    cookieHeader = "session=mobile-cookie",
                    csrfToken = "csrf-123",
                ),
                trustedForRestore = true,
            ),
        ),
    )

    private fun response(
        body: String,
        cookies: List<String> = emptyList(),
    ) = CompanionHttpResponse(
        statusCode = 200,
        body = body,
        headers = emptyMap(),
        contentType = "application/json",
        setCookieHeaders = cookies,
    )
}

private class ScriptedSessionTransport(
    getSteps: List<() -> CompanionHttpResponse> = emptyList(),
    postSteps: List<() -> CompanionHttpResponse> = emptyList(),
    deleteSteps: List<() -> CompanionHttpResponse> = emptyList(),
) : CompanionHttpTransport {
    private val pendingGets = java.util.ArrayDeque(getSteps)
    private val pendingPosts = java.util.ArrayDeque(postSteps)
    private val pendingDeletes = java.util.ArrayDeque(deleteSteps)

    val getRequests = mutableListOf<CompanionHttpRequest>()
    val postRequests = mutableListOf<CompanionHttpRequest>()
    val deleteRequests = mutableListOf<CompanionHttpRequest>()

    override suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse {
        getRequests += request
        return pendingGets.removeFirst().invoke()
    }

    override suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse {
        postRequests += request
        return pendingPosts.removeFirst().invoke()
    }

    override suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse {
        deleteRequests += request
        return pendingDeletes.removeFirst().invoke()
    }
}

private fun legacyHandshakeFailure(): CompanionTransportException = CompanionTransportException(
    CompanionTransportFailure(
        kind = CompanionTransportFailureKind.AuthenticationRequired,
        userMessage = "Требуется вход в Xkeen UI.",
        statusCode = 401,
        serverCode = "unauthorized",
    ),
)

private class RecordingSessionTransport(
    private val getResponse: CompanionHttpResponse? = null,
    private val postResponse: CompanionHttpResponse? = null,
    private val deleteResponse: CompanionHttpResponse? = null,
) : CompanionHttpTransport {
    val getRequests = mutableListOf<CompanionHttpRequest>()
    val postRequests = mutableListOf<CompanionHttpRequest>()
    val deleteRequests = mutableListOf<CompanionHttpRequest>()

    override suspend fun get(request: CompanionHttpRequest): CompanionHttpResponse {
        getRequests += request
        return requireNotNull(getResponse) { "No GET response configured." }
    }

    override suspend fun post(request: CompanionHttpRequest): CompanionHttpResponse {
        postRequests += request
        return requireNotNull(postResponse) { "No POST response configured." }
    }

    override suspend fun delete(request: CompanionHttpRequest): CompanionHttpResponse {
        deleteRequests += request
        return requireNotNull(deleteResponse) { "No DELETE response configured." }
    }
}
