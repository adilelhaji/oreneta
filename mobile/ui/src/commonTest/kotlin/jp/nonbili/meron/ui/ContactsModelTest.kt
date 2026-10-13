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

    @Test
    fun namesFollowTheDesktopsOrderOnlyWhenTheBookKeepsTheirParts() {
        assertEquals("contact_name_display", CONTACT_NAME_DISPLAY_SETTING_KEY)
        assertEquals("contact_name_sort", CONTACT_NAME_SORT_SETTING_KEY)
        assertEquals(ContactNameDisplay.LastCommaFirst, contactNameDisplayFromSetting("last_comma_first"))
        assertEquals(ContactNameDisplay.AsWritten, contactNameDisplayFromSetting("auto"))
        assertEquals(ContactNameDisplay.AsWritten, contactNameDisplayFromSetting(null))
        assertEquals(ContactNameSort.Last, contactNameSortFromSetting("last"))
        assertEquals(ContactNameSort.Name, contactNameSortFromSetting(3L))

        val ada = person("a", name = "Ada Lovelace").copy(given = "Ada", family = "Lovelace")
        assertEquals("Ada Lovelace", ada.displayLabel())
        assertEquals("Lovelace, Ada", ada.displayLabel(ContactNameDisplay.LastCommaFirst))
        assertEquals("Lovelace Ada", ada.displayLabel(ContactNameDisplay.LastFirst))
        val wang = person("w", name = "王芳").copy(given = "芳", family = "王")
        assertEquals("王芳", wang.displayLabel(ContactNameDisplay.LastFirst))
        // A whole name is never split by guessing.
        assertEquals("María José García López", person("m", name = "María José García López").displayLabel(ContactNameDisplay.LastCommaFirst))
    }

    @Test
    fun theListIsOrderedByTheChosenPart() {
        val zoe = person("z", name = "Zoe Adams").copy(given = "Zoe", family = "Adams")
        val bob = person("b", name = "Bob Young").copy(given = "Bob", family = "Young")
        val mallory = person("m", name = "Mallory")
        val people = listOf(zoe, bob, mallory)
        assertEquals(listOf("z", "b", "m"), sortedForList(people, ContactNameSort.Name).map { it.id }, "the core's order")
        assertEquals(listOf("b", "m", "z"), sortedForList(people, ContactNameSort.First).map { it.id })
        assertEquals(listOf("z", "m", "b"), sortedForList(people, ContactNameSort.Last).map { it.id })
    }
}
