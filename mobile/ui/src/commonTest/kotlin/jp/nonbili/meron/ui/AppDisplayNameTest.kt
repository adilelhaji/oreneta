package jp.nonbili.meron.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// What people read says Oreneta; the packages keep Meron's name (#247).
class AppDisplayNameTest {
    @Test
    fun drawerAndAboutShowOreneta() {
        assertEquals("Oreneta", APP_DISPLAY_NAME)
    }

    @Test
    fun themeLabelsNameOreneta() {
        assertEquals("Oreneta Light", AppAppearanceMode.Light.label)
        assertEquals("Oreneta Dark", AppAppearanceMode.Dark.label)
        // The stored values are what existing settings hold, so they stay.
        assertEquals("light", AppAppearanceMode.Light.storageValue)
        assertEquals("dark", AppAppearanceMode.Dark.storageValue)
        assertTrue(AppAppearanceMode.entries.none { it.label.contains("Meron") })
    }
}
