//! A look at bencoded torrent data before the engine parses it. The engine's parser recurses once per
//! nested list or dictionary, so a crafted .torrent of a few hundred kilobytes of `l` overflows the
//! stack and takes the app down; one that stays queued does so again on every start. This walks the
//! bytes with a loop instead, so no input can exhaust the stack here.

use std::fmt;

/// How deeply lists and dictionaries may nest: the same limit as the engine's own parser
/// (`vendor/librqbit-bencode`, upstream rqbit #660). Real torrents nest about 6 deep.
pub const MAX_DEPTH: usize = 128;

/// The largest torrent kept or handed to the engine: it fetches info dictionaries of up to 32 MiB
/// from peers, and the file around one adds its trackers.
pub const MAX_TORRENT_BYTES: usize = 33 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    TooLarge { max: usize },
    TooDeep,
    Malformed,
}

impl fmt::Display for Refused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { max } => write!(f, "it is larger than {} MB", max.div_ceil(1024 * 1024)),
            Self::TooDeep => write!(f, "its data is nested more than {MAX_DEPTH} levels deep"),
            Self::Malformed => f.write_str("it is not valid torrent data"),
        }
    }
}

impl std::error::Error for Refused {}

/// Whether `bytes` is one complete bencoded value, at most `max_len` bytes long and nested at most
/// `MAX_DEPTH` deep, with nothing after it. Says nothing about what the value means: the engine
/// still decides whether it is a torrent.
pub fn check(bytes: &[u8], max_len: usize) -> Result<(), Refused> {
    if bytes.len() > max_len {
        return Err(Refused::TooLarge { max: max_len });
    }
    let mut depth = 0;
    let mut at = 0;
    loop {
        match *bytes.get(at).ok_or(Refused::Malformed)? {
            b'l' | b'd' => {
                depth += 1;
                if depth > MAX_DEPTH {
                    return Err(Refused::TooDeep);
                }
                at += 1;
                // A container opened is not a value finished.
                continue;
            }
            b'e' if depth > 0 => {
                depth -= 1;
                at += 1;
            }
            b'i' => {
                let end = bytes[at + 1..].iter().position(|&b| b == b'e').ok_or(Refused::Malformed)?;
                at += end + 2;
            }
            b'0'..=b'9' => {
                let colon = bytes[at..].iter().position(|&b| b == b':').ok_or(Refused::Malformed)?;
                let digits = &bytes[at..at + colon];
                if !digits.iter().all(u8::is_ascii_digit) {
                    return Err(Refused::Malformed);
                }
                // Longer than the input is not there, however many digits say so.
                let len = std::str::from_utf8(digits).ok().and_then(|d| d.parse::<usize>().ok()).ok_or(Refused::Malformed)?;
                at = (at + colon + 1).checked_add(len).filter(|&end| end <= bytes.len()).ok_or(Refused::Malformed)?;
            }
            _ => return Err(Refused::Malformed),
        }
        if depth == 0 {
            return if at == bytes.len() { Ok(()) } else { Err(Refused::Malformed) };
        }
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    const BIG: usize = usize::MAX;

    /// `depth` lists, one inside the other, around an integer.
    fn nested(depth: usize) -> Vec<u8> {
        [vec![b'l'; depth], b"i1e".to_vec(), vec![b'e'; depth]].concat()
    }

    /// A torrent whose info dictionary carries a key nobody reads, holding `depth` nested lists:
    /// the shape that crashed the engine, as the info dictionary of a magnet's metadata would carry it.
    fn crafted_torrent(depth: usize) -> Vec<u8> {
        let info = [b"d6:lengthi1e4:name1:a12:piece lengthi16384e6:pieces20:".to_vec(), vec![0; 20]].concat();
        [b"d4:info".to_vec(), info, b"3:zzz".to_vec(), nested(depth), b"ee".to_vec()].concat()
    }

    #[test]
    fn nesting_up_to_the_limit_passes_and_one_more_is_refused() {
        assert_eq!(check(&nested(MAX_DEPTH), BIG), Ok(()));
        assert_eq!(check(&nested(MAX_DEPTH + 1), BIG), Err(Refused::TooDeep));
        // The torrent's own dictionaries count: 2 of them, so 126 more lists is the most.
        assert_eq!(check(&crafted_torrent(MAX_DEPTH - 2), BIG), Ok(()));
        assert_eq!(check(&crafted_torrent(MAX_DEPTH - 1), BIG), Err(Refused::TooDeep));
    }

    #[test]
    fn a_huge_nesting_is_refused_without_exhausting_the_stack() {
        // 100,000 levels (about 200 KB), the reported attack; and a megabyte of `l` that never closes.
        assert_eq!(check(&crafted_torrent(100_000), BIG), Err(Refused::TooDeep));
        assert_eq!(check(&vec![b'l'; 1 << 20], BIG), Err(Refused::TooDeep));
        assert_eq!(check(&vec![b'd'; 1 << 20], BIG), Err(Refused::TooDeep));
    }

    #[test]
    fn depth_is_how_deep_containers_nest_not_how_many_there_are() {
        // 10,000 lists side by side are 1 deep.
        let wide = [b"l".to_vec(), b"le".repeat(10_000), b"e".to_vec()].concat();
        assert_eq!(check(&wide, BIG), Ok(()));
        // Containers that close bring the depth back down.
        let saw = [nested(MAX_DEPTH), nested(MAX_DEPTH)].concat();
        let list = [b"l".to_vec(), saw[..].to_vec(), b"e".to_vec()].concat();
        assert_eq!(check(&list, BIG), Err(Refused::TooDeep), "inside a list each one is a level deeper");
        let pair = [b"l".to_vec(), nested(MAX_DEPTH - 1), nested(MAX_DEPTH - 1), b"e".to_vec()].concat();
        assert_eq!(check(&pair, BIG), Ok(()));
    }

    #[test]
    fn brackets_inside_strings_are_text_not_nesting() {
        let text = [format!("{}:", 100_000).into_bytes(), vec![b'l'; 100_000]].concat();
        assert_eq!(check(&text, BIG), Ok(()));
        let in_dict = [b"d4:name".to_vec(), text, b"e".to_vec()].concat();
        assert_eq!(check(&in_dict, BIG), Ok(()));
    }

    #[test]
    fn size_is_checked_at_the_limit_and_one_past_it() {
        let value = b"4:spam";
        assert_eq!(check(value, value.len()), Ok(()));
        assert_eq!(check(value, value.len() - 1), Err(Refused::TooLarge { max: value.len() - 1 }));
        assert_eq!(check(b"", 0), Err(Refused::Malformed));
    }

    #[test]
    fn broken_data_is_malformed() {
        for bad in [
            &b""[..],
            b"l",
            b"le e",
            b"lee",
            b"e",
            b"d",
            b"i12",
            b"5:spam",
            b"99999999999999999999999:x",
            b"18446744073709551615:x",
            b"4spam",
            b"-1:x",
            b"x",
            b"i1ei2e",
            b"4:spam ",
        ] {
            assert_eq!(check(bad, BIG), Err(Refused::Malformed), "{:?}", String::from_utf8_lossy(bad));
        }
    }

    #[test]
    fn real_torrents_pass() {
        assert_eq!(check(&crafted_torrent(1), BIG), Ok(()));
        assert_eq!(check(b"d8:announce3:url13:announce-listll3:url3:twoeee", BIG), Ok(()));
    }

    #[test]
    fn the_engine_refuses_what_this_refuses_instead_of_crashing() {
        // The engine's own parser is patched (vendor/librqbit-bencode); if an update of the engine
        // drops the patch, this overflows the stack instead of failing cleanly.
        let deep = crafted_torrent(100_000);
        let parsed = std::thread::Builder::new()
            .stack_size(1 << 20)
            .spawn(move || librqbit::torrent_from_bytes(&deep).is_ok())
            .unwrap()
            .join()
            .unwrap();
        assert!(!parsed);
        assert!(librqbit::torrent_from_bytes(&crafted_torrent(MAX_DEPTH - 2)).is_ok(), "at the limit it still parses");
    }

    /// Any bencoded value, nested at most `depth` deep.
    fn value(depth: u32) -> impl Strategy<Value = Vec<u8>> {
        let leaf = prop_oneof![
            any::<i64>().prop_map(|i| format!("i{i}e").into_bytes()),
            prop::collection::vec(any::<u8>(), 0..16).prop_map(|s| [format!("{}:", s.len()).into_bytes(), s].concat()),
        ];
        leaf.prop_recursive(depth, 64, 4, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..4)
                    .prop_map(|items| [b"l".to_vec(), items.concat(), b"e".to_vec()].concat()),
                prop::collection::vec((prop::collection::vec(any::<u8>(), 0..8), inner), 0..4).prop_map(|pairs| {
                    let body: Vec<u8> =
                        pairs.into_iter().flat_map(|(k, v)| [format!("{}:", k.len()).into_bytes(), k, v].concat()).collect();
                    [b"d".to_vec(), body, b"e".to_vec()].concat()
                }),
            ]
        })
    }

    proptest! {
        #[test]
        fn every_well_formed_value_within_the_limits_passes(bytes in value(8)) {
            prop_assert_eq!(check(&bytes, BIG), Ok(()));
        }

        #[test]
        fn wrapping_a_value_deeper_than_the_limit_is_refused(bytes in value(4), extra in MAX_DEPTH..MAX_DEPTH * 4) {
            let wrapped = [vec![b'l'; extra], bytes, vec![b'e'; extra]].concat();
            prop_assert_eq!(check(&wrapped, BIG), Err(Refused::TooDeep));
        }

        #[test]
        fn a_value_cut_short_or_followed_by_more_is_malformed(bytes in value(6), cut in any::<prop::sample::Index>()) {
            let cut = cut.index(bytes.len());
            prop_assert_eq!(check(&bytes[..cut], BIG), Err(Refused::Malformed));
            prop_assert_eq!(check(&[bytes.clone(), b"i0e".to_vec()].concat(), BIG), Err(Refused::Malformed));
        }

        #[test]
        fn arbitrary_bytes_never_panic(bytes in prop::collection::vec(any::<u8>(), 0..512)) {
            let _ = check(&bytes, BIG);
        }
    }
}
