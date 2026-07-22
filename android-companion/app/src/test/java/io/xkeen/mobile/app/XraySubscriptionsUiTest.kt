package io.xkeen.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Test

class XraySubscriptionsUiTest {
    @Test
    fun latencyToneUsesGreenYellowAndRedRanges() {
        assertEquals(
            SubscriptionLatencyTone.Fast,
            subscriptionLatencyTone(false, OutboundLatency("ok", 119)),
        )
        assertEquals(
            SubscriptionLatencyTone.Moderate,
            subscriptionLatencyTone(false, OutboundLatency("ok", 120)),
        )
        assertEquals(
            SubscriptionLatencyTone.Moderate,
            subscriptionLatencyTone(false, OutboundLatency("ok", 299)),
        )
        assertEquals(
            SubscriptionLatencyTone.Slow,
            subscriptionLatencyTone(false, OutboundLatency("ok", 300)),
        )
    }

    @Test
    fun latencyToneKeepsOperationalStatesDistinct() {
        assertEquals(
            SubscriptionLatencyTone.Pending,
            subscriptionLatencyTone(true, OutboundLatency("error", null)),
        )
        assertEquals(
            SubscriptionLatencyTone.Error,
            subscriptionLatencyTone(false, OutboundLatency("error", null)),
        )
        assertEquals(
            SubscriptionLatencyTone.Unknown,
            subscriptionLatencyTone(false, null),
        )
        assertEquals(
            SubscriptionLatencyTone.Unknown,
            subscriptionLatencyTone(false, OutboundLatency("ok", -1)),
        )
    }
}
