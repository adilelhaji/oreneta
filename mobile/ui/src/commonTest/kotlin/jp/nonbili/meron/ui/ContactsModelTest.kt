package jp.nonbili.meron.ui

import jp.nonbili.meron.shared.PersonDraft
import jp.nonbili.meron.shared.PersonEmail
import jp.nonbili.meron.shared.PersonPhone
import jp.nonbili.meron.shared.PersonSummary
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ContactsModelTest {
    private fun person(
        id: String,
        source: String = "local",
        editable: Boolean = true,
        link: String? = null,
        name: String = id,
    ) = PersonSummary(id = id, source = source, editable = editable, link = link, name = name, version = "v-$id")

    @Test
    fun onlyLocalAndWritableCardDavPeopleAreEditable() {
        assertTrue(person("a").editableOnMobile())
        assertTrue(person("b", source = "carddav").editableOnMobile())
        assertFalse(person("c", source = "carddav", editable = false).editableOnMobile(), "a CardDAV book the server marks read-only")
        // Even if a core said otherwise, Google and the directory stay read-only here.
        assertFalse(person("d", source = "google").editableOnMobile())
        assertFalse(person("e", source = "exchange").editableOnMobile())
        assertEquals("people.source.google", person("d", source = "google").sourceKey())
        assertEquals("people.source.local", person("x", source = "").sourceKey())
    }

    @Test
    fun linkedPeopleShowOnce() {
        val people = listOf(person("a", link = "l1"), person("b"), person("c", link = "l1"), person("d", link = "l2"))
        assertEquals(listOf("a", "b", "d"), collapseLinked(people).map { it.id })
    }

    @Test
    fun aNamelessPersonIsLabelledByHowToReachThem() {
        assertEquals("ann@example.com", PersonSummary(id = "1", emails = listOf(PersonEmail("ann@example.com"))).displayLabel())
        assertEquals("Acme", PersonSummary(id = "1", organisation = "Acme").displayLabel())
        assertEquals("+1 555", PersonSummary(id = "1", phones = listOf(PersonPhone("+1 555"))).displayLabel())
    }

    @Test
    fun savesSendTrimmedFieldsAndTheVersionTheyWereReadAt() {
        val ann =
            PersonSummary(
                id = "local-1",
                name = "Ann",
                emails = listOf(PersonEmail("ann@example.com", "work")),
                version = "3",
                editable = true,
            )
        val editing =
            ann.editing().copy(
                draft =
                    ann.toDraft().copy(
                        name = "  Ann Lee ",
                        emails = listOf(PersonEmail(" ann@example.com ", "work"), PersonEmail("  ", "")),
                        phones = listOf(PersonPhone("", "mobile")),
                    ),
            )
        assertEquals(
            """{"id":"local-1","version":"3","person":{"name":"Ann Lee","organisation":"","note":"",""" +
                """"emails":[{"addr":"ann@example.com","label":"work"}],"phones":[]}}""",
            editing.saveParams().toJson(),
        )
        assertEquals("""{"id":"local-1","version":"3"}""", ann.deleteParams().toJson())

        // A new contact names no id, version or book: it goes to this device's book.
        val created = ContactEditing(draft = PersonDraft(name = "New"))
        assertTrue(created.isNew)
        assertEquals("""{"person":{"name":"New","organisation":"","note":"","emails":[],"phones":[]}}""", created.saveParams().toJson())
        assertFalse(ContactEditing().draft.hasContent(), "the empty address row offered to a new contact is not content")
    }

    @Test
    fun keepingMineAfterAConflictSavesFromTheCurrentVersionOrCreatesAgain() {
        val editing = ContactEditing(id = "local-1", version = "3", draft = PersonDraft(name = "Mine"))
        val changed = editing.copy(conflict = ContactConflict(person("local-1").copy(version = "5")))
        val retry = changed.keepingMine()
        assertEquals("5", retry.version)
        assertEquals("local-1", retry.id)
        assertEquals(null, retry.conflict)

        val deleted = editing.copy(conflict = ContactConflict(null)).keepingMine()
        assertTrue(deleted.isNew)
        assertEquals("Mine", deleted.draft.name)
    }
}
