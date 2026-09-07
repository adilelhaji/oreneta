use crate::calendar::Participant;

use super::exchange::people_from_participants;

fn entry(name: &str, addr: &str) -> Participant {
    Participant {
        name: name.into(),
        addr: addr.into(),
        ..Default::default()
    }
}

#[test]
fn a_directory_entry_becomes_a_person_with_one_address() {
    let people = people_from_participants(vec![entry("Ana Prat", "Ana@Hospital.cat")]);
    assert_eq!(people.len(), 1);
    assert_eq!(people[0].name, "Ana Prat");
    assert_eq!(people[0].emails[0].addr, "ana@hospital.cat");
    assert_eq!(people[0].uid, "ana@hospital.cat");
}

#[test]
fn an_entry_that_is_not_an_address_is_nobody_the_composer_can_use() {
    // An internal identifier the resolver could not turn into an address.
    assert!(people_from_participants(vec![entry("Ana", "/o=Org/ou=Group/cn=ana")]).is_empty());
    assert!(people_from_participants(vec![entry("Room 3", "")]).is_empty());
}

#[test]
fn a_nameless_entry_is_called_by_its_address() {
    assert_eq!(people_from_participants(vec![entry("", "ana@x.com")])[0].name, "ana@x.com");
}

#[test]
fn the_same_address_twice_is_one_person() {
    let people = people_from_participants(vec![entry("Ana", "ana@x.com"), entry("Ana P.", "ANA@X.COM")]);
    assert_eq!(people.len(), 1);
}
