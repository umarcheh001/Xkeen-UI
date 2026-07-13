package io.xkeen.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PersistedConnectionsPortTest {
    @Test
    fun connectionsMetadataAndSelectionSurvivePortRecreation() {
        val storage = FakeConnectionsStorage()
        val firstPort = PersistedConnectionsPort(storage, idFactory = { "generated-id" })
        val created = firstPort.save(
            draft = ConnectionDraft(
                name = "Домашний узел",
                baseUrl = "https://lab.lan:8443",
            ),
            existing = null,
        )
        firstPort.select(created.id)
        firstPort.update(
            created.copy(
                status = ConnectionStatus.NeedsAuth,
                lastSeen = "Вход устарел",
            ),
        )

        val restored = PersistedConnectionsPort(storage).load()

        assertEquals("generated-id", restored.selectedConnectionId)
        assertEquals(
            Connection(
                id = "generated-id",
                name = "Домашний узел",
                baseUrl = "https://lab.lan:8443",
                status = ConnectionStatus.NeedsAuth,
                lastSeen = "Вход устарел",
            ),
            restored.connections.single(),
        )
    }

    @Test
    fun editingPersistedConnectionKeepsIdStatusAndListPosition() {
        val first = Connection(
            id = "first",
            name = "Первый",
            baseUrl = "http://first.lan",
            status = ConnectionStatus.Configured,
            lastSeen = "Готово",
        )
        val second = Connection(
            id = "second",
            name = "Второй",
            baseUrl = "http://second.lan",
            status = ConnectionStatus.Offline,
            lastSeen = "Офлайн",
        )
        val storage = FakeConnectionsStorage(
            encodeStoredConnections(
                StoredConnections(
                    connections = listOf(first, second),
                    selectedConnectionId = second.id,
                ),
            ),
        )
        val port = PersistedConnectionsPort(storage, idFactory = { "must-not-be-used" })

        val updated = port.save(
            draft = ConnectionDraft(
                name = "Второй узел",
                baseUrl = "https://second.lan:8443",
                editingConnectionId = second.id,
            ),
            existing = second,
        )

        val restored = PersistedConnectionsPort(storage).load()
        assertEquals(listOf("first", "second"), restored.connections.map(Connection::id))
        assertEquals(second.id, updated.id)
        assertEquals(second.status, updated.status)
        assertEquals(second.lastSeen, updated.lastSeen)
        assertEquals(second.id, restored.selectedConnectionId)
    }

    @Test
    fun malformedRecordsAndUnknownSelectionDoNotBreakRestore() {
        val valid = Connection(
            id = "valid",
            name = "Рабочий узел",
            baseUrl = "http://valid.lan",
            status = ConnectionStatus.SetupRequired,
            lastSeen = "Новый черновик",
        )
        val payload = encodeStoredConnections(
            StoredConnections(
                connections = listOf(valid),
                selectedConnectionId = valid.id,
            ),
        ).replace("selected:${encodeFieldForTest(valid.id)}", "selected:${encodeFieldForTest("missing")}") +
            "connection:not|a|valid|record\n"

        val restored = decodeStoredConnections(payload)

        assertEquals(listOf(valid), restored.connections)
        assertNull(restored.selectedConnectionId)
    }
}

private class FakeConnectionsStorage(
    initial: String? = null,
) : ConnectionsStorage {
    private var payload: String? = initial

    override fun read(): String? = payload

    override fun write(payload: String) {
        this.payload = payload
    }
}

private fun encodeFieldForTest(value: String): String =
    java.util.Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(value.toByteArray(Charsets.UTF_8))
