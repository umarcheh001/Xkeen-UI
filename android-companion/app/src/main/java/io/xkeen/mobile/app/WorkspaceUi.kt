package io.xkeen.mobile.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.FactCheck
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Save
import androidx.compose.material.icons.outlined.SettingsBackupRestore
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun RoutingWorkspaceScreen(
    state: CompanionUiState,
    controller: DemoCompanionController,
    modifier: Modifier = Modifier,
) {
    val routing = state.routing
    val selectedDocument = routing.documents.firstOrNull {
        it.id == routing.selectedDocumentId
    } ?: return

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(Color(0xFFF7F7F5)),
    ) {
        DocumentToolbar(
            document = selectedDocument,
            documents = routing.documents,
            onSelectDocument = controller::selectRoutingDocument,
            onEdit = controller::enterRoutingEditMode,
            onValidate = controller::validateRouting,
            onRevert = controller::revertRoutingDraft,
            onSave = controller::saveRouting,
            onApply = controller::requestRoutingApply,
        )
        JsonEditor(
            value = selectedDocument.draftContent,
            onValueChange = controller::updateRoutingDraft,
            modifier = Modifier.weight(1f),
        )
        EditorStatusBar(
            document = selectedDocument,
            validation = routing.validation,
        )
    }
}

@Composable
private fun DocumentToolbar(
    document: RoutingDocument,
    documents: List<RoutingDocument>,
    onSelectDocument: (String) -> Unit,
    onEdit: () -> Unit,
    onValidate: () -> Unit,
    onRevert: () -> Unit,
    onSave: () -> Unit,
    onApply: () -> Unit,
) {
    val currentIndex = documents.indexOfFirst { it.id == document.id }.coerceAtLeast(0)
    val nextDocument = documents.getOrNull((currentIndex + 1) % documents.size)

    Surface(
        color = Color(0xFFF5F6F5),
        shadowElevation = 1.dp,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .clickable { nextDocument?.let { onSelectDocument(it.id) } }
                    .padding(start = 18.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = document.title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (documents.size > 1) {
                    Text(
                        text = "  ${currentIndex + 1}/${documents.size}",
                        style = MaterialTheme.typography.labelMedium,
                        color = Color(0xFF7A7F82),
                    )
                }
            }
            EditorToolbarButton(Icons.Outlined.Edit, "Редактировать", onEdit)
            EditorToolbarButton(Icons.AutoMirrored.Outlined.FactCheck, "Проверить", onValidate)
            EditorToolbarButton(Icons.Outlined.SettingsBackupRestore, "Откатить", onRevert)
            EditorToolbarButton(
                icon = Icons.Outlined.Save,
                description = "Сохранить",
                onClick = onSave,
                accent = document.hasUnsavedChanges,
            )
            EditorToolbarButton(
                icon = Icons.Outlined.DoneAll,
                description = "Применить",
                onClick = onApply,
                accent = document.hasDraftChanges,
            )
        }
    }
}

@Composable
private fun EditorToolbarButton(
    icon: ImageVector,
    description: String,
    onClick: () -> Unit,
    accent: Boolean = false,
) {
    IconButton(onClick = onClick, modifier = Modifier.size(42.dp)) {
        Icon(
            imageVector = icon,
            contentDescription = description,
            tint = if (accent) Color(0xFF0F766E) else Color(0xFF465058),
        )
    }
}

@Composable
private fun JsonEditor(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val lineCount = value.count { it == '\n' } + 1

    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(Color(0xFFFBFBFA))
            .verticalScroll(rememberScrollState())
            .padding(top = 8.dp, bottom = 24.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = (1..lineCount).joinToString("\n"),
            modifier = Modifier
                .width(45.dp)
                .padding(end = 7.dp),
            color = Color(0xFF9A9A96),
            fontFamily = FontFamily.Monospace,
            fontSize = 15.sp,
            lineHeight = 23.sp,
            textAlign = TextAlign.End,
        )
        Box(
            modifier = Modifier
                .width(1.dp)
                .heightIn(min = 640.dp)
                .background(Color(0xFFE0E1DE)),
        )
        Box(
            modifier = Modifier
                .weight(1f)
                .horizontalScroll(rememberScrollState()),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier
                    .widthIn(min = 600.dp)
                    .heightIn(min = 640.dp)
                    .padding(start = 10.dp, end = 12.dp),
                textStyle = MaterialTheme.typography.bodyMedium.copy(
                    color = Color(0xFF2B2E31),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 15.sp,
                    lineHeight = 23.sp,
                ),
                cursorBrush = SolidColor(Color(0xFF6A5D15)),
                visualTransformation = JsonVisualTransformation,
            )
        }
    }
}

private object JsonVisualTransformation : VisualTransformation {
    private val stringPattern = Regex("\"(?:\\\\.|[^\"\\\\])*\"")
    private val keyPattern = Regex("\"(?:\\\\.|[^\"\\\\])*\"(?=\\s*:)")
    private val numberPattern = Regex("(?<![A-Za-z])[-+]?\\d+(?:\\.\\d+)?")
    private val keywordPattern = Regex("\\b(?:true|false|null)\\b")
    private val commentPattern = Regex("//.*")

    override fun filter(text: AnnotatedString): TransformedText {
        val styled = buildAnnotatedString {
            append(text.text)
            stringPattern.findAll(text.text).forEach { match ->
                addStyle(SpanStyle(color = Color(0xFF2D7B31)), match.range.first, match.range.last + 1)
            }
            keyPattern.findAll(text.text).forEach { match ->
                addStyle(SpanStyle(color = Color(0xFF25712A)), match.range.first, match.range.last + 1)
            }
            numberPattern.findAll(text.text).forEach { match ->
                addStyle(SpanStyle(color = Color(0xFF345D9D)), match.range.first, match.range.last + 1)
            }
            keywordPattern.findAll(text.text).forEach { match ->
                addStyle(SpanStyle(color = Color(0xFF8A4D9D)), match.range.first, match.range.last + 1)
            }
            commentPattern.findAll(text.text).forEach { match ->
                addStyle(SpanStyle(color = Color(0xFF77731E)), match.range.first, match.range.last + 1)
            }
        }
        return TransformedText(styled, OffsetMapping.Identity)
    }
}

@Composable
private fun EditorStatusBar(
    document: RoutingDocument,
    validation: RoutingValidation,
) {
    val statusText = when {
        validation.state == RoutingValidationState.Invalid -> validation.message
        validation.state == RoutingValidationState.Valid -> validation.message
        document.hasUnsavedChanges -> "Изменения не сохранены"
        document.hasDraftChanges -> "Черновик сохранён"
        else -> "r${document.revision} · опубликовано"
    }
    val statusColor = when (validation.state) {
        RoutingValidationState.Invalid -> Color(0xFFB42318)
        RoutingValidationState.Valid -> Color(0xFF287A35)
        RoutingValidationState.Dirty -> Color(0xFF8A6811)
        RoutingValidationState.Idle -> Color(0xFF6C7275)
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(30.dp)
            .background(Color(0xFFEEEFEA))
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(7.dp)
                .background(statusColor, CircleShape),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = statusText,
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.labelMedium,
            color = Color(0xFF485054),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = "Ln ${document.draftContent.lines().size}",
            style = MaterialTheme.typography.labelMedium,
            color = Color(0xFF6C7275),
        )
    }
}

@Composable
internal fun ModulePlaceholderScreen(
    title: String,
    subtitle: String,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color(0xFFF7F7F5))
            .padding(28.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(text = title, style = MaterialTheme.typography.headlineSmall)
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
internal fun ShellWorkspaceScreen(
    state: CompanionUiState,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(Color(0xFF172126))
            .padding(14.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Text(
            text = "xkeen@${state.dashboard.instanceLabel.lowercase().replace(' ', '-')}:~$",
            color = Color(0xFF8DD69A),
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
        )
        state.logs.entries.forEach { entry ->
            Text(
                text = "${entry.time}  [${entry.source}]  ${entry.message}",
                color = if (entry.level == LogLevel.Error) Color(0xFFFF9B91) else Color(0xFFD5E0E4),
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                lineHeight = 17.sp,
            )
        }
    }
}
