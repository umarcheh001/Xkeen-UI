package io.xkeen.mobile.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.xkeen.mobile.ui.theme.WebPanelPalette

/** Shared compact switch: a 34×20 dp visual track inside a 44×32 dp touch target. */
@Composable
internal fun XkeenCompactSwitch(
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .size(width = 44.dp, height = 32.dp)
            .clickable(enabled = enabled, role = Role.Switch) { onCheckedChange(!checked) },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(width = 34.dp, height = 20.dp)
                .background(
                    when {
                        !enabled -> WebPanelPalette.SurfaceRaised
                        checked -> WebPanelPalette.Border
                        else -> WebPanelPalette.MutedDeep.copy(alpha = 0.55f)
                    },
                    CircleShape,
                )
                .padding(3.dp),
            contentAlignment = if (checked) Alignment.CenterEnd else Alignment.CenterStart,
        ) {
            Box(
                modifier = Modifier
                    .size(14.dp)
                    .background(
                        if (checked) WebPanelPalette.Background else WebPanelPalette.Muted,
                        CircleShape,
                    ),
            )
        }
    }
}
