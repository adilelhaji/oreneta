package jp.nonbili.meron.shared

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PeopleCommandsTest {
    // What main.rs writes for `people.list`, inside the platform envelope.
    private val peopleJson =
        """{"id":1,"result":{"people":[""" +
            """{"id":"local-1","source":"local","account":"","book":"local","name":"Ann Lee","given":"Ann","family":"Lee","organisation":"Acme","note":"Met at \"the\" fair",""" +
            """"photo":"","emails":[{"addr":"ann@example.com","label":"work"},{"addr":"","label":"home"}],"phones":[{"number":"+34 600 000 000","label":"mobile"}],""" +
            """"version":"3","link":null,"editable":true},""" +
            """{"id":"g-7","source":"google","account":"me@gmail.com","book":"google:me@gmail.com","name":"Bo","organisation":"","note":"",""" +
            """"photo":"people/g-7.jpg","emails":[{"addr":"bo@example.com","label":""}],"phones":[],"version":"etag-9","link":"link-1","editable":false}""" +
            """]}}"""

    @Test
    fun peopleListReadsNestedEmailsAndPhonesAndTheEditableFlag() {
        val people = parsePeopleListResponse(peopleJson)
        assertEquals(2, people.size)
        val ann = people[0]
        assertEquals("local-1", ann.id)
        assertEquals("local", ann.source)
        assertEquals("Ann Lee", ann.name, "the person's name, not an email's label")
        assertEquals("Acme", ann.organisation)
        assertEquals("Met at \"the\" fair", ann.note)
        assertEquals(listOf(PersonEmail("ann@example.com", "work")), ann.emails, "a blank address is dropped")
        assertEquals(listOf(PersonPhone("+34 600 000 000", "mobile")), ann.phones)
        assertEquals("3", ann.version)
        assertTrue(ann.editable)
        assertNull(ann.link)
        assertEquals("Ann", ann.given)
        assertEquals("Lee", ann.family)

        val bo = people[1]
        assertEquals("google", bo.source)
        assertEquals("me@gmail.com", bo.account)
        assertEquals("people/g-7.jpg", bo.photo)
        assertFalse(bo.editable)
        assertEquals("link-1", bo.link)
        assertEquals("", bo.family, "a book that keeps no parts has none")
    }

    // people.go forwards `people.list` with query and limit, and the writes
    // unchanged from frontend/src/states/people.ts.
    @Test
    fun requestsMatchWhatTheDesktopSends() {
        assertEquals("people.list", MobileCommand.PeopleList)
        assertEquals("people.save", MobileCommand.PeopleSave)
        assertEquals("people.delete", MobileCommand.PeopleDelete)
        assertEquals("""{"query":"ann","limit":2000}""", PeopleListParams("ann").toJson())

        val draft =
            PersonDraft(
                name = "Ann",
                organisation = "Acme",
                note = "",
                emails = listOf(PersonEmail("ann@example.com", "work")),
                phones = listOf(PersonPhone("+1 555", "")),
            )
        val person =
            """{"name":"Ann","organisation":"Acme","note":"","emails":[{"addr":"ann@example.com","label":"work"}],"phones":[{"number":"+1 555","label":""}]}"""
        // A new person: no id, no version; the local book unless one is named.
        assertEquals("""{"person":$person}""", PeopleSaveParams(person = draft).toJson())
        assertEquals("""{"book":"carddav-1","person":$person}""", PeopleSaveParams(book = "carddav-1", person = draft).toJson())
        // An edit names the version it was read at, and never a book.
        assertEquals(
            """{"id":"local-1","version":"3","person":$person}""",
            PeopleSaveParams(id = "local-1", version = "3", book = "carddav-1", person = draft).toJson(),
        )
        assertEquals("""{"id":"local-1","version":"","person":$person}""", PeopleSaveParams(id = "local-1", person = draft).toJson())
        assertEquals("""{"id":"local-1","version":"3"}""", PeopleDeleteParams("local-1", "3").toJson())
    }

    @Test
    fun writeAnswersAreSavedOrAConflictWithTheCurrentCopy() {
        assertEquals(
            PersonWriteResult.Saved("local-1", "4"),
            parsePersonWriteResponse("""{"id":1,"result":{"ok":true,"id":"local-1","version":"4"}}"""),
        )
        val conflict =
            parsePersonWriteResponse(
                """{"id":1,"result":{"ok":false,"conflict":true,"current":{"id":"local-1","name":"Annie","organisation":"","note":"","emails":[],"phones":[],"version":"5"}}}""",
            )
        assertIs<PersonWriteResult.Conflict>(conflict)
        assertEquals("Annie", conflict.current?.name)
        assertEquals("5", conflict.current?.version)

        val deleted = parsePersonWriteResponse("""{"id":1,"result":{"ok":false,"conflict":true,"current":null}}""")
        assertEquals(PersonWriteResult.Conflict(null), deleted)
    }

    @Test
    fun clientSendsTheSaveItWasGiven() {
        val core = RecordingCore("""{"id":1,"result":{"ok":true,"id":"local-9","version":"1"}}""")
        val params = PeopleSaveParams(person = PersonDraft(name = "New"))
        val answer = runBlockingTest { MobilePeopleCommandClient(core).save(params) }
        assertEquals("people.save", core.lastCommand)
        assertEquals(params.toJson(), core.lastPayloadJson)
        assertEquals(PersonWriteResult.Saved("local-9", "1"), parsePersonWriteResponse(answer))
    }
}
