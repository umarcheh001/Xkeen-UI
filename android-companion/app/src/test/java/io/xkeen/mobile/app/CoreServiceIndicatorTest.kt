package io.xkeen.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Test

class CoreServiceIndicatorTest {
    @Test
    fun runningServiceUsesRunningIndicator() {
        val indicator = coreServiceIndicator(ServiceState.Running, ServiceOperationState())

        assertEquals(CoreServiceIndicatorTone.Running, indicator.tone)
        assertEquals("Сервис работает", indicator.description)
    }

    @Test
    fun stoppedServiceUsesStoppedIndicator() {
        val indicator = coreServiceIndicator(ServiceState.Stopped, ServiceOperationState())

        assertEquals(CoreServiceIndicatorTone.Stopped, indicator.tone)
        assertEquals("Сервис остановлен", indicator.description)
    }

    @Test
    fun pendingOperationTakesPriorityOverConfirmedState() {
        val indicator = coreServiceIndicator(
            serviceState = ServiceState.Running,
            operation = ServiceOperationState(
                phase = ServiceOperationPhase.Pending,
                action = ServiceAction.Restart,
            ),
        )

        assertEquals(CoreServiceIndicatorTone.Busy, indicator.tone)
        assertEquals("Перезапуск сервиса", indicator.description)
    }

    @Test
    fun transitionalAndUnknownStatesUseBusyIndicator() {
        assertEquals(
            CoreServiceIndicatorTone.Busy,
            coreServiceIndicator(ServiceState.Restarting, ServiceOperationState()).tone,
        )
        assertEquals(
            CoreServiceIndicatorTone.Busy,
            coreServiceIndicator(ServiceState.Unknown, ServiceOperationState()).tone,
        )
    }
}
