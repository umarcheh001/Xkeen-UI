package io.xkeen.mobile.app

import android.app.Application
import androidx.lifecycle.AndroidViewModel

/**
 * Keeps the active mobile session and unsaved routing drafts alive while Android recreates the
 * activity for a configuration change, such as rotating the device.
 */
internal class CompanionViewModel(application: Application) : AndroidViewModel(application) {
    val controller = CompanionController(
        dependencies = defaultCompanionControllerDependencies(
            connections = persistedConnectionsPort(application),
            sessionMaterials = secureSessionMaterialStore(application),
            xrayLogsPreferences = persistedXrayLogsPreferencesPort(application),
            appContext = application,
        ),
    )
}
