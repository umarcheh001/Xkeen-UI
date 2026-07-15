package io.xkeen.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SecureSessionMaterialStoreTest {
    @Test
    fun trustedSessionMaterialSurvivesStoreRecreation() {
        val storage = FakeSecureSessionMaterialStorage()
        val expected = StoredSessionMaterial(
            connectionId = "home-node",
            material = SessionMaterial(
                accessToken = "access-token",
                refreshToken = "refresh-token",
                cookieHeader = "xkeen_session=cookie-value",
                csrfToken = "csrf-value",
            ),
            trustedForRestore = true,
        )

        PersistedSessionMaterialStore(storage).save(expected)
        val restored = PersistedSessionMaterialStore(storage)

        assertEquals(expected, restored.load("home-node"))
        assertEquals(expected, restored.loadTrusted("home-node"))
    }

    @Test
    fun untrustedSessionMaterialIsNeverReturnedAsRestorable() {
        val store = PersistedSessionMaterialStore(FakeSecureSessionMaterialStorage())
        val material = StoredSessionMaterial(
            connectionId = "lab-node",
            material = SessionMaterial(accessToken = "temporary-token"),
            trustedForRestore = false,
        )

        store.save(material)

        assertEquals(material, store.load("lab-node"))
        assertNull(store.loadTrusted("lab-node"))
    }

    @Test
    fun logoutClearsOnlyTheSelectedConnectionMaterial() {
        val storage = FakeSecureSessionMaterialStorage()
        val store = PersistedSessionMaterialStore(storage)
        store.save(
            StoredSessionMaterial(
                connectionId = "first",
                material = SessionMaterial(accessToken = "first-token"),
                trustedForRestore = true,
            ),
        )
        store.save(
            StoredSessionMaterial(
                connectionId = "second",
                material = SessionMaterial(accessToken = "second-token"),
                trustedForRestore = true,
            ),
        )

        store.clear("first")

        assertNull(store.load("first"))
        assertEquals("second-token", store.loadTrusted("second")?.material?.accessToken)
        assertTrue(storage.payload.orEmpty().isNotBlank())
    }

    @Test
    fun malformedOrEmptySecretRecordsAreIgnored() {
        val payload = """
            xkeen-session-material-v1
            session:not-base64|.|.|.|.|1
            session:dmFsaWQ|.|.|.|.|1
        """.trimIndent()

        assertTrue(decodeStoredSessionMaterials(payload).isEmpty())
    }

    @Test
    fun demoLoginPersistsSyntheticSecretButNeverThePasswordOrTrustedMarker() {
        val storage = FakeSecureSessionMaterialStorage()
        val materials = PersistedSessionMaterialStore(storage)
        val session = DemoSessionPort(
            sessionMaterials = materials,
            demoSessionSecretFactory = { "demo-session-secret" },
        )
        val connection = Connection(
            id = "demo-node",
            name = "Демо",
            baseUrl = "https://demo.lan",
            status = ConnectionStatus.NeedsAuth,
            lastSeen = "Требуется вход",
        )

        session.login(connection, LoginForm(username = "admin", password = "must-not-be-saved"))

        assertEquals("demo-session-secret", materials.load("demo-node")?.material?.accessToken)
        assertNull(materials.loadTrusted("demo-node"))
        assertFalse(storage.payload.orEmpty().contains("must-not-be-saved"))

        session.disconnect(connection)

        assertNull(materials.load("demo-node"))
        assertNull(storage.payload)
    }
}

private class FakeSecureSessionMaterialStorage : SecureSessionMaterialStorage {
    var payload: String? = null

    override fun read(): String? = payload

    override fun write(payload: String) {
        this.payload = payload
    }

    override fun clear() {
        payload = null
    }
}
