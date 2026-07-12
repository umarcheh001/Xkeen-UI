package io.xkeen.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CoreStatusSourceTest {
    @Test
    fun normalizesOnlySupportedCoreNames() {
        assertEquals("Xray", canonicalCoreName(" XRAY "))
        assertEquals("Mihomo", canonicalCoreName("mihomo"))
        assertNull(canonicalCoreName("sing-box"))
    }
}
