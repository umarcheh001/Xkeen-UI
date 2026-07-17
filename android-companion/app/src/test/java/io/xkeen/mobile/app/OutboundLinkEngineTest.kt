package io.xkeen.mobile.app

import java.nio.charset.StandardCharsets
import java.util.Base64
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboundLinkEngineTest {
    @Test
    fun vlessPreviewMasksSecretsAndNormalizeCanonicalizesAliases() {
        val raw = "vless://123e4567-e89b-12d3-a456-426614174000@example.com" +
            "?net=ws&publicKey=public-secret&shortId=abcd&serverName=cdn.example.com&path=api#My%20Node"

        val normalized = normalizeOutboundLink(raw) ?: throw AssertionError("Normalization failed")
        val preview = previewOutboundLink(normalized)

        assertTrue(normalized.startsWith("vless://123e4567-e89b-12d3-a456-426614174000@example.com:443?"))
        assertTrue("type=ws" in normalized)
        assertTrue("security=reality" in normalized)
        assertTrue("pbk=public-secret" in normalized)
        assertTrue("sid=abcd" in normalized)
        assertTrue("sni=cdn.example.com" in normalized)
        assertTrue("path=%2Fapi" in normalized)
        assertFalse("publicKey=" in normalized)
        assertFalse("shortId=" in normalized)
        assertFalse("serverName=" in normalized)
        assertTrue(preview.isValid)
        assertEquals("ws", preview.transport)
        assertEquals("reality", preview.security)
        assertEquals("My Node", preview.fields.first { it.label == "Название" }.value)
        assertFalse(preview.fields.first { it.label == "UUID" }.value.contains("123e4567-e89b-12d3-a456-426614174000"))
    }

    @Test
    fun vmessPreviewAndNormalizeAddSafeDefaults() {
        val payload = JSONObject()
            .put("ps", "Demo")
            .put("add", "vmess.example.com")
            .put("id", "123e4567-e89b-12d3-a456-426614174000")
            .put("net", "ws")
            .put("path", "socket")
        val raw = "vmess://" + Base64.getEncoder().encodeToString(
            payload.toString().toByteArray(StandardCharsets.UTF_8),
        )

        val normalized = normalizeOutboundLink(raw) ?: throw AssertionError("Normalization failed")
        val normalizedJson = JSONObject(
            String(
                Base64.getDecoder().decode(normalized.substringAfter("vmess://")),
                StandardCharsets.UTF_8,
            ),
        )
        val preview = previewOutboundLink(normalized)

        assertEquals("2", normalizedJson.getString("v"))
        assertEquals("0", normalizedJson.getString("aid"))
        assertEquals("443", normalizedJson.getString("port"))
        assertEquals("/socket", normalizedJson.getString("path"))
        assertTrue(preview.isValid)
        assertEquals("ws", preview.transport)
    }

    @Test
    fun shadowsocksNormalizeProducesStandardSingleLink() {
        val credentials = Base64.getEncoder().encodeToString("aes-256-gcm:secret".toByteArray())
        val raw = "ss://$credentials@ss.example.com:8388?plugin=v2ray-plugin%3Btls#Stockholm"

        val normalized = normalizeOutboundLink(raw) ?: throw AssertionError("Normalization failed")
        val preview = previewOutboundLink(normalized)

        assertTrue(normalized.startsWith("ss://$credentials@ss.example.com:8388"))
        assertTrue(preview.isValid)
        assertEquals("aes-256-gcm", preview.fields.first { it.label == "Cipher" }.value)
        assertEquals("Stockholm", preview.fields.first { it.label == "Название" }.value)
    }

    @Test
    fun invalidSchemeAndTagAreRejectedOrCleanedLocally() {
        val preview = previewOutboundLink("socks://localhost:1080")

        assertFalse(preview.isValid)
        assertTrue(preview.errors.isNotEmpty())
        assertEquals("my_proxy", cleanOutboundTag("  my proxy/тест  "))
    }
}
