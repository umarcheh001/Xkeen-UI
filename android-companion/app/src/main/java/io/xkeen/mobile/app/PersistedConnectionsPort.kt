package io.xkeen.mobile.app

import android.content.Context
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.UUID

private const val CONNECTIONS_PREFERENCES_NAME = "xkeen_mobile_connections"
private const val CONNECTIONS_PAYLOAD_KEY = "connections_payload"
private const val CONNECTIONS_FORMAT_HEADER = "xkeen-connections-v1"

internal interface ConnectionsStorage {
    fun read(): String?

    fun write(payload: String)
}

internal class SharedPreferencesConnectionsStorage(
    context: Context,
) : ConnectionsStorage {
    private val preferences = context.applicationContext.getSharedPreferences(
        CONNECTIONS_PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    override fun read(): String? = preferences.getString(CONNECTIONS_PAYLOAD_KEY, null)

    override fun write(payload: String) {
        check(preferences.edit().putString(CONNECTIONS_PAYLOAD_KEY, payload).commit()) {
            "Не удалось сохранить подключения в локальное хранилище."
        }
    }
}

internal class PersistedConnectionsPort(
    private val storage: ConnectionsStorage,
    private val idFactory: () -> String = { UUID.randomUUID().toString() },
) : ConnectionsPort {
    private var cached: StoredConnections? = null

    override fun load(): StoredConnections = current()

    override fun save(
        draft: ConnectionDraft,
        existing: Connection?,
    ): Connection {
        val current = current()
        val connection = connectionFromDraft(
            draft = draft,
            existing = existing,
            idFactory = idFactory,
        )
        persist(current.copy(connections = current.connections.upsert(connection)))
        return connection
    }

    override fun update(connection: Connection) {
        val current = current()
        persist(current.copy(connections = current.connections.upsert(connection)))
    }

    override fun select(connectionId: String) {
        val current = current()
        if (current.connections.any { it.id == connectionId }) {
            persist(current.copy(selectedConnectionId = connectionId))
        }
    }

    private fun current(): StoredConnections = cached ?: decodeStoredConnections(storage.read())
        .also { cached = it }

    private fun persist(value: StoredConnections) {
        val sanitized = value.sanitized()
        storage.write(encodeStoredConnections(sanitized))
        cached = sanitized
    }
}

internal fun persistedConnectionsPort(context: Context): ConnectionsPort =
    PersistedConnectionsPort(SharedPreferencesConnectionsStorage(context))

internal fun encodeStoredConnections(value: StoredConnections): String = buildString {
    val sanitized = value.sanitized()
    appendLine(CONNECTIONS_FORMAT_HEADER)
    append("selected:")
    appendLine(sanitized.selectedConnectionId.encodeField())
    sanitized.connections.forEach { connection ->
        append("connection:")
        appendLine(
            listOf(
                connection.id,
                connection.name,
                connection.baseUrl,
                connection.status.name,
                connection.lastSeen,
            ).joinToString("|") { it.encodeField() },
        )
    }
}

internal fun decodeStoredConnections(payload: String?): StoredConnections {
    if (payload.isNullOrBlank()) {
        return StoredConnections()
    }

    val lines = payload.lineSequence().toList()
    if (lines.firstOrNull() != CONNECTIONS_FORMAT_HEADER) {
        return StoredConnections()
    }

    val selectedConnectionId = lines
        .firstOrNull { it.startsWith("selected:") }
        ?.substringAfter("selected:")
        ?.decodeFieldOrNull()
        ?.ifBlank { null }
    val connections = lines.mapNotNull { line ->
        if (!line.startsWith("connection:")) {
            return@mapNotNull null
        }
        val fields = line.substringAfter("connection:").split('|')
        if (fields.size != 5) {
            return@mapNotNull null
        }
        runCatching {
            Connection(
                id = fields[0].decodeField(),
                name = fields[1].decodeField(),
                baseUrl = fields[2].decodeField(),
                status = enumValueOf(fields[3].decodeField()),
                lastSeen = fields[4].decodeField(),
            )
        }.getOrNull()
    }

    return StoredConnections(
        connections = connections,
        selectedConnectionId = selectedConnectionId,
    ).sanitized()
}

private fun String?.encodeField(): String {
    if (this.isNullOrEmpty()) {
        return "."
    }
    return Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(toByteArray(StandardCharsets.UTF_8))
}

private fun String.decodeField(): String =
    if (this == ".") {
        ""
    } else {
        String(Base64.getUrlDecoder().decode(this), StandardCharsets.UTF_8)
    }

private fun String.decodeFieldOrNull(): String? = runCatching(::decodeField).getOrNull()
