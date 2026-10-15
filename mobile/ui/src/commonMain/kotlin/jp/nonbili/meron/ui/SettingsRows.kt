package jp.nonbili.meron.ui

import androidx.compose.runtime.Composable

/** The row a settings list opens at when a refused proxy sends the person there (#201). */
internal const val SETTINGS_ROW_NETWORK = "network"

/**
 * The rows of a settings list, declared in order, with a name on the rows a
 * screen can be opened at. The list is shown from this same declaration, so
 * where a named row sits follows the rows above it, conditional ones included,
 * instead of a position counted by hand.
 */
internal class SettingsRows {
    private val keys = mutableListOf<String?>()
    private val contents = mutableListOf<@Composable () -> Unit>()

    val size: Int
        get() = contents.size

    fun row(
        key: String? = null,
        content: @Composable () -> Unit,
    ) {
        keys += key
        contents += content
    }

    fun content(index: Int): @Composable () -> Unit = contents[index]

    /** Where the list opens: at the row named [key] when asked for and present, otherwise at the top. */
    fun startIndex(key: String?): Int = key?.let { keys.indexOf(it) }?.takeIf { it >= 0 } ?: 0
}

internal fun settingsRows(build: SettingsRows.() -> Unit): SettingsRows = SettingsRows().apply(build)
