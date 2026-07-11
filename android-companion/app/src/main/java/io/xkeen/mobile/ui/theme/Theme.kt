package io.xkeen.mobile.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val LightColors = lightColorScheme(
    primary = Sky,
    onPrimary = Snow,
    primaryContainer = SkySoft,
    onPrimaryContainer = Ink,
    secondary = Teal,
    onSecondary = Snow,
    secondaryContainer = TealSoft,
    onSecondaryContainer = Teal,
    tertiary = Amber,
    onTertiary = Snow,
    tertiaryContainer = AmberSoft,
    onTertiaryContainer = AmberDeep,
    error = Danger,
    onError = Snow,
    errorContainer = DangerSoft,
    onErrorContainer = Danger,
    background = Mist,
    onBackground = Ink,
    surface = Snow,
    onSurface = Ink,
    surfaceContainerLowest = Snow,
    surfaceContainerLow = Mist,
    surfaceContainer = Cloud,
    surfaceContainerHighest = SkySoft,
    onSurfaceVariant = Slate,
)

private val DarkColors = darkColorScheme(
    primary = SkySoft,
    onPrimary = Midnight,
    primaryContainer = SkyStrong,
    onPrimaryContainer = Snow,
    secondary = TealSoft,
    onSecondary = Midnight,
    secondaryContainer = Teal,
    onSecondaryContainer = Snow,
    tertiary = AmberSoft,
    onTertiary = Midnight,
    tertiaryContainer = AmberDeep,
    onTertiaryContainer = Snow,
    error = DangerSoft,
    onError = Midnight,
    errorContainer = Danger,
    onErrorContainer = Snow,
    background = Midnight,
    onBackground = Snow,
    surface = Panel,
    onSurface = Snow,
    surfaceContainerLowest = Midnight,
    surfaceContainerLow = Panel,
    surfaceContainer = PanelRaised,
    surfaceContainerHighest = PanelEdge,
    onSurfaceVariant = Fog,
)

@Composable
fun XkeenMobileTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = XkeenTypography,
        content = content,
    )
}
