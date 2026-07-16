package io.xkeen.mobile.app

import org.junit.Assert.assertEquals
import org.junit.Test

class RoutingWorkflowTest {
    private val original = demoRoutingState().documents.first()

    @Test
    fun changedTextRequiresValidateThenSave() {
        val edited = original.copy(
            draftContent = original.draftContent + "\n// changed",
            savedDraftContent = original.draftContent,
        )

        assertEquals(
            RoutingWorkflowStep.Validate,
            routingWorkflowStep(edited, RoutingValidation(state = RoutingValidationState.Dirty)),
        )
        assertEquals(
            RoutingWorkflowStep.Save,
            routingWorkflowStep(edited, RoutingValidation(state = RoutingValidationState.Valid)),
        )
    }

    @Test
    fun savedServerDraftRequiresApplyAndPublishedTextIsComplete() {
        val saved = original.copy(
            publishedContent = "// published",
            savedDraftContent = "// checked draft",
            draftContent = "// checked draft",
            hasServerSavedDraft = true,
        )
        assertEquals(
            RoutingWorkflowStep.Apply,
            routingWorkflowStep(saved, RoutingValidation(state = RoutingValidationState.Valid)),
        )

        val applied = saved.copy(
            publishedContent = saved.draftContent,
            hasServerSavedDraft = false,
        )
        assertEquals(
            RoutingWorkflowStep.Complete,
            routingWorkflowStep(applied, RoutingValidation(state = RoutingValidationState.Valid)),
        )
    }
}
