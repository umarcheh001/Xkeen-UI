package io.xkeen.mobile.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val SESSION_PREFERENCES_NAME = "xkeen_mobile_session_material"
private const val SESSION_PAYLOAD_KEY = "encrypted_session_payload"
private const val SESSION_KEYSTORE_ALIAS = "io.xkeen.mobile.session-material.v1"
private const val SESSION_PAYLOAD_AAD = "xkeen-mobile-session-material-v1"
private const val SESSION_CIPHER_FORMAT = "xkeen-session-cipher-v1"
private const val SESSION_MATERIAL_FORMAT_HEADER = "xkeen-session-material-v1"
private const val GCM_IV_LENGTH_BYTES = 12
private const val GCM_TAG_LENGTH_BITS = 128

/**
 * Sensitive values returned by a future mobile session bootstrap.
 *
 * Passwords deliberately do not belong here: they are used only for the login request and are
 * never persisted. The current demo adapter stores a synthetic access token only to exercise the
 * same persistence boundary as the future transport adapter.
 */
internal data class SessionMaterial(
    val accessToken: String? = null,
    val refreshToken: String? = null,
    val cookieHeader: String? = null,
    val csrfToken: String? = null,
) {
    val hasSecrets: Boolean
        get() = listOf(accessToken, refreshToken, cookieHeader, csrfToken).any {
            !it.isNullOrBlank()
        }
}

/**
 * A per-connection secret record. Only [trustedForRestore] authorizes a future cold-start
 * restore attempt; a persisted Connection with Configured metadata is not sufficient.
 */
internal data class StoredSessionMaterial(
    val connectionId: String,
    val material: SessionMaterial,
    val trustedForRestore: Boolean,
)

internal interface SessionMaterialStore {
    fun load(connectionId: String): StoredSessionMaterial?

    fun loadTrusted(connectionId: String): StoredSessionMaterial?

    fun save(value: StoredSessionMaterial)

    fun clear(connectionId: String)
}

/**
 * The storage boundary deliberately exposes plaintext only after the platform implementation has
 * decrypted it. Tests use an in-memory implementation of this interface without Android Keystore.
 */
internal interface SecureSessionMaterialStorage {
    fun read(): String?

    fun write(payload: String)

    fun clear()
}

internal class PersistedSessionMaterialStore(
    private val storage: SecureSessionMaterialStorage,
) : SessionMaterialStore {
    private var cached: List<StoredSessionMaterial>? = null

    override fun load(connectionId: String): StoredSessionMaterial? =
        current().firstOrNull { it.connectionId == connectionId }

    override fun loadTrusted(connectionId: String): StoredSessionMaterial? =
        load(connectionId)?.takeIf(StoredSessionMaterial::trustedForRestore)

    override fun save(value: StoredSessionMaterial) {
        val sanitized = value.sanitizedOrNull() ?: return
        persist(current().upsert(sanitized))
    }

    override fun clear(connectionId: String) {
        if (connectionId.isBlank()) {
            return
        }
        persist(current().filterNot { it.connectionId == connectionId })
    }

    private fun current(): List<StoredSessionMaterial> = cached
        ?: decodeStoredSessionMaterials(storage.read()).also { cached = it }

    private fun persist(value: List<StoredSessionMaterial>) {
        val sanitized = value.sanitized()
        if (sanitized.isEmpty()) {
            storage.clear()
        } else {
            storage.write(encodeStoredSessionMaterials(sanitized))
        }
        cached = sanitized
    }
}

internal class InMemorySessionMaterialStore(
    initial: List<StoredSessionMaterial> = emptyList(),
) : SessionMaterialStore {
    private var stored = initial.sanitized()

    override fun load(connectionId: String): StoredSessionMaterial? =
        stored.firstOrNull { it.connectionId == connectionId }

    override fun loadTrusted(connectionId: String): StoredSessionMaterial? =
        load(connectionId)?.takeIf(StoredSessionMaterial::trustedForRestore)

    override fun save(value: StoredSessionMaterial) {
        value.sanitizedOrNull()?.let { stored = stored.upsert(it) }
    }

    override fun clear(connectionId: String) {
        stored = stored.filterNot { it.connectionId == connectionId }
    }
}

internal fun secureSessionMaterialStore(context: Context): SessionMaterialStore =
    PersistedSessionMaterialStore(AndroidKeystoreSessionMaterialStorage(context))

/**
 * Keeps a single encrypted payload in app-private SharedPreferences. Its AES key is non-exportable
 * and lives in Android Keystore, so SharedPreferences never receives a raw token, cookie or CSRF
 * value. If the key is invalidated or the ciphertext is damaged, the unusable payload is removed.
 */
internal class AndroidKeystoreSessionMaterialStorage(
    context: Context,
) : SecureSessionMaterialStorage {
    private val preferences = context.applicationContext.getSharedPreferences(
        SESSION_PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )
    private val cipher = AndroidKeystoreAesGcmCipher()

    override fun read(): String? {
        val encryptedPayload = preferences.getString(SESSION_PAYLOAD_KEY, null) ?: return null
        return runCatching { cipher.decrypt(encryptedPayload) }
            .getOrElse {
                clear()
                null
            }
    }

    override fun write(payload: String) {
        val encryptedPayload = cipher.encrypt(payload)
        check(preferences.edit().putString(SESSION_PAYLOAD_KEY, encryptedPayload).commit()) {
            "Не удалось сохранить защищенный session material."
        }
    }

    override fun clear() {
        check(preferences.edit().remove(SESSION_PAYLOAD_KEY).commit()) {
            "Не удалось очистить защищенный session material."
        }
    }
}

internal fun encodeStoredSessionMaterials(value: List<StoredSessionMaterial>): String = buildString {
    appendLine(SESSION_MATERIAL_FORMAT_HEADER)
    value.sanitized().forEach { session ->
        append("session:")
        appendLine(
            listOf(
                session.connectionId,
                session.material.accessToken,
                session.material.refreshToken,
                session.material.cookieHeader,
                session.material.csrfToken,
            ).joinToString("|") { it.encodeSessionField() } +
                "|" + if (session.trustedForRestore) "1" else "0",
        )
    }
}

internal fun decodeStoredSessionMaterials(payload: String?): List<StoredSessionMaterial> {
    if (payload.isNullOrBlank()) {
        return emptyList()
    }
    val lines = payload.lineSequence().toList()
    if (lines.firstOrNull() != SESSION_MATERIAL_FORMAT_HEADER) {
        return emptyList()
    }

    return lines.mapNotNull { line ->
        if (!line.startsWith("session:")) {
            return@mapNotNull null
        }
        val fields = line.substringAfter("session:").split('|')
        if (fields.size != 6 || fields.last() !in setOf("0", "1")) {
            return@mapNotNull null
        }
        runCatching {
            StoredSessionMaterial(
                connectionId = fields[0].decodeSessionField(),
                material = SessionMaterial(
                    accessToken = fields[1].decodeSessionFieldOrNull(),
                    refreshToken = fields[2].decodeSessionFieldOrNull(),
                    cookieHeader = fields[3].decodeSessionFieldOrNull(),
                    csrfToken = fields[4].decodeSessionFieldOrNull(),
                ),
                trustedForRestore = fields[5] == "1",
            ).sanitizedOrNull()
        }.getOrNull()
    }.sanitized()
}

private class AndroidKeystoreAesGcmCipher {
    fun encrypt(plaintext: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(SESSION_PAYLOAD_AAD.toByteArray(StandardCharsets.UTF_8))
        val ciphertext = cipher.doFinal(plaintext.toByteArray(StandardCharsets.UTF_8))
        return listOf(
            SESSION_CIPHER_FORMAT,
            cipher.iv.toBase64Url(),
            ciphertext.toBase64Url(),
        ).joinToString(":")
    }

    fun decrypt(encodedPayload: String): String {
        val parts = encodedPayload.split(':')
        require(parts.size == 3 && parts[0] == SESSION_CIPHER_FORMAT) {
            "Неизвестный формат защищенного session material."
        }
        val iv = parts[1].fromBase64Url()
        require(iv.size == GCM_IV_LENGTH_BYTES) {
            "Некорректный IV защищенного session material."
        }
        val ciphertext = parts[2].fromBase64Url()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv))
        cipher.updateAAD(SESSION_PAYLOAD_AAD.toByteArray(StandardCharsets.UTF_8))
        return String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8)
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return (keyStore.getKey(SESSION_KEYSTORE_ALIAS, null) as? SecretKey)
            ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
                init(
                    KeyGenParameterSpec.Builder(
                        SESSION_KEYSTORE_ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                    )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256)
                        .setRandomizedEncryptionRequired(true)
                        .build(),
                )
                generateKey()
            }
    }
}

private fun List<StoredSessionMaterial>.sanitized(): List<StoredSessionMaterial> =
    mapNotNull(StoredSessionMaterial::sanitizedOrNull).distinctBy(StoredSessionMaterial::connectionId)

private fun List<StoredSessionMaterial>.upsert(value: StoredSessionMaterial): List<StoredSessionMaterial> =
    if (any { it.connectionId == value.connectionId }) {
        map { current -> if (current.connectionId == value.connectionId) value else current }
    } else {
        listOf(value) + this
    }

private fun StoredSessionMaterial.sanitizedOrNull(): StoredSessionMaterial? {
    val sanitizedMaterial = material.sanitized()
    return takeIf { connectionId.isNotBlank() && sanitizedMaterial.hasSecrets }
        ?.copy(material = sanitizedMaterial)
}

private fun SessionMaterial.sanitized(): SessionMaterial = copy(
    accessToken = accessToken.takeSecretOrNull(),
    refreshToken = refreshToken.takeSecretOrNull(),
    cookieHeader = cookieHeader.takeSecretOrNull(),
    csrfToken = csrfToken.takeSecretOrNull(),
)

private fun String?.takeSecretOrNull(): String? = takeIf { !it.isNullOrBlank() }

private fun String?.encodeSessionField(): String =
    if (isNullOrEmpty()) {
        "."
    } else {
        Base64.getUrlEncoder().withoutPadding().encodeToString(toByteArray(StandardCharsets.UTF_8))
    }

private fun String.decodeSessionField(): String =
    if (this == ".") "" else String(Base64.getUrlDecoder().decode(this), StandardCharsets.UTF_8)

private fun String.decodeSessionFieldOrNull(): String? =
    decodeSessionField().takeSecretOrNull()

private fun ByteArray.toBase64Url(): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(this)

private fun String.fromBase64Url(): ByteArray = Base64.getUrlDecoder().decode(this)
