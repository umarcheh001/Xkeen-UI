package io.xkeen.mobile.app

import java.io.File
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdateControllerTest {
    @Test
    fun checkDownloadAndInstallFollowTheSuccessfulStateMachine() = runTest {
        val release = testUpdateRelease()
        val port = RecordingAppUpdatePort(
            checkResult = AppUpdateCheckResult.Available(release),
            installResult = AppUpdateInstallResult.Started,
        )
        val controller = CompanionController(
            initialState = CompanionUiState(
                appUpdate = AppUpdateState(currentVersion = "0.3.0-beta.1"),
            ),
            dependencies = defaultCompanionControllerDependencies(appUpdate = port),
        )

        controller.checkForAppUpdate()

        assertEquals(AppUpdatePhase.Available, controller.state.appUpdate.phase)
        assertEquals(release, controller.state.appUpdate.release)
        assertEquals("0.3.0-beta.1", port.checkedVersion)

        controller.downloadAppUpdate()

        assertEquals(AppUpdatePhase.ReadyToInstall, controller.state.appUpdate.phase)
        assertEquals(100, controller.state.appUpdate.progressPercent)
        assertTrue(controller.state.appUpdate.downloadedBytes > 0)
        assertEquals(AppUpdateInstallResult.Started, controller.installAppUpdate())
        assertNotNull(port.installedDownload)
    }

    @Test
    fun failedDownloadKeepsReleaseAndCanBeRetried() = runTest {
        val release = testUpdateRelease()
        val port = RecordingAppUpdatePort(
            checkResult = AppUpdateCheckResult.Available(release),
            downloadFailure = IllegalStateException("network interrupted"),
        )
        val controller = CompanionController(
            initialState = CompanionUiState(
                appUpdate = AppUpdateState(currentVersion = "0.3.0-beta.1"),
            ),
            dependencies = defaultCompanionControllerDependencies(appUpdate = port),
        )

        controller.checkForAppUpdate()
        controller.downloadAppUpdate()

        assertEquals(AppUpdatePhase.Error, controller.state.appUpdate.phase)
        assertEquals(release, controller.state.appUpdate.release)
        assertEquals("network interrupted", controller.state.appUpdate.error)
        assertEquals(AppUpdateInstallResult.Failed, controller.installAppUpdate())
    }

    @Test
    fun recheckClearsStaleReleaseBeforeReportingApiFailure() = runTest {
        val stale = testUpdateRelease()
        val port = RecordingAppUpdatePort(
            checkResult = AppUpdateCheckResult.Unavailable("GitHub API unavailable"),
        )
        val controller = CompanionController(
            initialState = CompanionUiState(
                appUpdate = AppUpdateState(
                    phase = AppUpdatePhase.Available,
                    currentVersion = "0.3.0-beta.1",
                    release = stale,
                ),
            ),
            dependencies = defaultCompanionControllerDependencies(appUpdate = port),
        )

        controller.checkForAppUpdate()

        assertEquals(AppUpdatePhase.Error, controller.state.appUpdate.phase)
        assertEquals(null, controller.state.appUpdate.release)
        assertEquals("GitHub API unavailable", controller.state.appUpdate.error)
    }
}

private class RecordingAppUpdatePort(
    private val checkResult: AppUpdateCheckResult,
    private val installResult: AppUpdateInstallResult = AppUpdateInstallResult.Failed,
    private val downloadFailure: Exception? = null,
) : AppUpdatePort {
    var checkedVersion: String? = null
    var installedDownload: AppUpdateDownload? = null

    override suspend fun check(currentVersion: String): AppUpdateCheckResult {
        checkedVersion = currentVersion
        return checkResult
    }

    override suspend fun download(
        release: AppUpdateRelease,
        onProgress: suspend (downloadedBytes: Long, totalBytes: Long) -> Unit,
    ): AppUpdateDownload {
        downloadFailure?.let { throw it }
        onProgress(4, 8)
        onProgress(8, 8)
        val file = File.createTempFile("xkeen-update-test", ".apk").apply {
            writeBytes(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8))
            deleteOnExit()
        }
        return AppUpdateDownload(file, release, "00".repeat(32))
    }

    override fun install(download: AppUpdateDownload): AppUpdateInstallResult {
        installedDownload = download
        return installResult
    }
}

private fun testUpdateRelease(): AppUpdateRelease = AppUpdateRelease(
    tagName = "v2.6.0",
    version = "0.4.0",
    title = "Xkeen Mobile 0.4.0",
    notes = "Update tests",
    releaseUrl = "https://github.com/umarcheh001/Xkeen-UI/releases/tag/v2.6.0",
    apkUrl = "https://github.com/umarcheh001/Xkeen-UI/releases/download/v2.6.0/xkeen-mobile.apk",
    apkName = "xkeen-mobile.apk",
    apkSizeBytes = 8,
    publishedAt = "2026-07-25T00:00:00Z",
    isPrerelease = false,
    checksumUrl = "https://github.com/umarcheh001/Xkeen-UI/releases/download/v2.6.0/xkeen-mobile.apk.sha256",
)
