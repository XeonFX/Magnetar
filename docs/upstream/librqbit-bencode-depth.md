# librqbit: nesting-depth limit in the bencode parser

## Status

- **The fix is already upstream.** ikatson/rqbit#660, "fix(bencode): limit deserializer recursion depth"
  (commit `eb96f1c6ba88f625ea6ef87d98b3fad9a2e85781`, merged 2026-09-08), adds `DEFAULT_MAX_DEPTH = 128`
  and a `BencodeDeserializer::with_max_depth` override.
- **It isn't released yet.** The latest crates.io release is `librqbit-bencode` 9.0.1 (2026-08-20), which
  still recurses without a limit. `main` was 24 commits ahead of `v9.0.1` on 2026-10-03.
- A second PR would duplicate #660. What upstream needs is a patch release, so the text below asks for
  9.0.2 (or a 9.0.x backport) instead of opening a PR.
- Until that release, Magnetar ships 9.0.1 with #660 applied (`vendor/librqbit-bencode`, wired in
  through `[patch.crates-io]` in the root `Cargo.toml`). Once a release with the fix is out: bump
  `librqbit`, delete `vendor/librqbit-bencode` and the `[patch.crates-io]` entry, and run
  `downloads::bencode::tests::the_engine_refuses_what_this_refuses_instead_of_crashing`.

## Why it matters

The parser recurses once per list or dictionary. Unknown keys are skipped through `deserialize_ignored_any`,
so the nesting doesn't even have to be in a field anyone reads. Measured against 9.0.1 on a 2 MiB
thread stack (the tokio worker default), with lists nested under an unknown key of a .torrent:

| Build   | Survives | Overflows the stack (abort) |
| ------- | -------- | --------------------------- |
| debug   | 2,000    | 4,000                       |
| release | 16,000   | 32,000                      |

Every level costs 1 byte of input in each direction (`l` and `e`). Where that input can come from:

- **.torrent files and magnet metadata** (info dictionaries of up to 32 MiB from peers): far past either
  limit, so they crash any build. A session that saved such a torrent crashes the next start too.
- **DHT packets** (16 KiB receive buffer, so 8,000 levels at most) and **peer extended messages** (about
  16 KiB): enough for a debug build, under the measured release limit. They have no margin for a
  different compiler, target or stack size.

## Issue text (to file on ikatson/rqbit)

**Title:** Release the bencode depth limit (#660) in 9.0.2

> Thanks for merging #660. Without it, `librqbit-bencode` 9.0.1 overflows the stack on deeply nested
> input and aborts the process. A crafted .torrent or the info dictionary of a magnet (around 200 KB of
> nested lists) is enough, and a session that saved such a torrent aborts again on every start.
> Measured on a 2 MiB stack: debug builds abort at about 4,000 levels and release builds at about
> 32,000. DHT packets and peer extended messages can reach 8,000.
>
> 9.0.1 is the latest release, so everyone on crates.io is still exposed. Could you cut a 9.0.2 (or a
> 9.0.x with just #660 cherry-picked)? Downstream we're carrying #660 as a `[patch.crates-io]` against
> 9.0.1 until then. It applies cleanly. The crate's tests pass with it, except the two that read
> `../librqbit/resources/*.torrent`, which the published crate doesn't include.

## The patch (9.0.1 + #660, as Magnetar vendors it)

Identical to #660, apart from one trailing comma in an existing test that rustfmt adds on `main`.

```diff
--- a/crates/bencode/src/deserialize.rs
+++ b/crates/bencode/src/deserialize.rs
@@ -8,11 +8,26 @@
 
 use crate::raw_value::TAG;
 
+/// The default maximum nesting depth accepted when deserializing.
+///
+/// Bencode itself (BEP 3) places no limit on nesting, so this is a
+/// receiver-side robustness limit, not a format limit. The deserializer is
+/// recursive, so without it an attacker-controlled payload of a few tens of
+/// kilobytes (e.g. a deeply nested tracker response, a malformed .torrent
+/// file, a BEP 10 extended message, or a DHT packet) overflows the stack and
+/// aborts the process. Legitimate bencode in the BitTorrent ecosystem is
+/// shallow (a .torrent peaks around depth 6; DHT and tracker messages around
+/// 3-4), so 128 leaves ~20x headroom over anything real. This matches
+/// serde_json's recursion limit; libtorrent's bdecode() defaults to 100.
+pub const DEFAULT_MAX_DEPTH: usize = 128;
+
 pub struct BencodeDeserializer<'de> {
     buf: &'de [u8],
     field_context: ErrorContext<'de>,
     field_context_did_not_fit: u8,
     parsing_key: bool,
+    depth: usize,
+    max_depth: usize,
 }
 
 impl<'de> BencodeDeserializer<'de> {
@@ -22,9 +37,22 @@
             field_context: Default::default(),
             field_context_did_not_fit: 0,
             parsing_key: false,
+            depth: 0,
+            max_depth: DEFAULT_MAX_DEPTH,
         }
     }
 
+    /// Override the maximum nesting depth (see [`DEFAULT_MAX_DEPTH`]).
+    ///
+    /// Raising this also raises the stack usage of the recursive parser:
+    /// each nesting level costs on the order of a few hundred bytes of
+    /// stack, so threads with small stacks (e.g. tokio workers default to
+    /// 2 MiB) should not set this much above the default.
+    pub fn with_max_depth(mut self, max_depth: usize) -> Self {
+        self.max_depth = max_depth;
+        self
+    }
+
     pub fn into_remaining(self) -> &'de [u8] {
         self.buf
     }
@@ -66,6 +94,18 @@
             self.field_context_did_not_fit = self.field_context_did_not_fit.saturating_add(1);
         }
         Ok(b)
+    }
+
+    /// Increment the nesting depth before recursing into a container's
+    /// elements. All container types (list, dict, struct, tuple) funnel
+    /// through deserialize_seq/deserialize_map, which are the only places
+    /// the parser recurses, so guarding these two guards everything.
+    fn enter_container(&mut self) -> Result<(), Error> {
+        if self.depth >= self.max_depth {
+            return Err(Error::DepthLimit(self.max_depth));
+        }
+        self.depth += 1;
+        Ok(())
     }
 }
 
@@ -120,6 +160,8 @@
     RawDeInvalidValue,
     #[error("invalid utf-8")]
     InvalidUtf8,
+    #[error("nesting depth exceeds the limit ({0})")]
+    DepthLimit(usize),
     #[error("eof")]
     Eof,
 }
@@ -359,7 +401,10 @@
         V: serde::de::Visitor<'de>,
     {
         self.parse_first_byte(b'l', Error::InvalidValue)?;
-        visitor.visit_seq(SeqAccess { de: self })
+        self.enter_container()?;
+        let r = visitor.visit_seq(SeqAccess { de: self });
+        self.depth -= 1;
+        r
     }
 
     fn deserialize_tuple<V>(self, _len: usize, visitor: V) -> Result<V::Value, Self::Error>
@@ -386,7 +431,10 @@
         V: serde::de::Visitor<'de>,
     {
         self.parse_first_byte(b'd', Error::InvalidValue)?;
-        visitor.visit_map(MapAccess { de: self })
+        self.enter_container()?;
+        let r = visitor.visit_map(MapAccess { de: self });
+        self.depth -= 1;
+        r
     }
 
     fn deserialize_struct<V>(
@@ -620,9 +668,11 @@
 
 #[cfg(test)]
 mod tests {
-    use buffers::ByteBuf;
+    use buffers::{ByteBuf, ByteBufOwned};
 
-    use crate::{WithRawBytes, from_bytes};
+    use super::{DEFAULT_MAX_DEPTH, Error};
+    use crate::{BencodeDeserializer, BencodeValue, WithRawBytes, from_bytes};
+    use serde::Deserialize as _;
 
     #[test]
     fn test_deserialize_error_context() {
@@ -766,8 +816,67 @@
             from_bytes::<S>(b"d3:keyi42e6:valuesl5:hello5:worldee").unwrap(),
             S {
                 key: 42,
-                values: vec![ByteBuf(b"hello"), ByteBuf(b"world")]
+                values: vec![ByteBuf(b"hello"), ByteBuf(b"world")],
             }
         );
     }
+
+    #[test]
+    fn test_nesting_at_default_limit_parses() {
+        fn nested(depth: usize) -> Vec<u8> {
+            let mut v = vec![b'l'; depth];
+            v.push(b'i');
+            v.extend_from_slice(b"42e");
+            v.extend(std::iter::repeat_n(b'e', depth));
+            v
+        }
+
+        // Exactly the limit parses fine (real torrents peak around depth 6).
+        let buf = nested(DEFAULT_MAX_DEPTH);
+        let v: BencodeValue<ByteBufOwned> = from_bytes(&buf).unwrap();
+        let mut cur = &v;
+        for _ in 0..DEFAULT_MAX_DEPTH {
+            cur = match cur {
+                BencodeValue::List(l) => &l[0],
+                other => panic!("unexpected shape at depth: {other:?}"),
+            };
+        }
+
+        // One past the limit is a clean error, not a stack overflow.
+        let buf = nested(DEFAULT_MAX_DEPTH + 1);
+        let e = from_bytes::<BencodeValue<ByteBufOwned>>(&buf).unwrap_err();
+        assert!(matches!(e.kind(), Error::DepthLimit(DEFAULT_MAX_DEPTH)));
+    }
+
+    #[test]
+    fn test_nesting_depth_limit_configurable() {
+        fn nested(depth: usize) -> Vec<u8> {
+            let mut v = vec![b'l'; depth];
+            v.extend_from_slice(b"i0e");
+            v.extend(std::iter::repeat_n(b'e', depth));
+            v
+        }
+
+        // Lower limit rejects shallower input; higher limit accepts it.
+        let buf = nested(10);
+        let mut de = BencodeDeserializer::new_from_buf(&buf).with_max_depth(5);
+        let e: Error = BencodeValue::<ByteBufOwned>::deserialize(&mut de).unwrap_err();
+        assert!(matches!(e, Error::DepthLimit(5)));
+
+        let buf = nested(10);
+        let mut de = BencodeDeserializer::new_from_buf(&buf).with_max_depth(usize::MAX);
+        let v: BencodeValue<ByteBufOwned> = serde::Deserialize::deserialize(&mut de).unwrap();
+        drop(v);
+    }
+
+    #[test]
+    fn test_nesting_unbalanced_deep_no_overflow() {
+        // A payload of bare 'l' bytes (no terminators): the old parser
+        // recursed before discovering the structure never closes. Must be
+        // a clean error at any size.
+        let buf = vec![b'l'; 1 << 20];
+        let mut de = BencodeDeserializer::new_from_buf(&buf);
+        let r: Result<BencodeValue<ByteBufOwned>, _> = serde::Deserialize::deserialize(&mut de);
+        assert!(r.is_err());
+    }
 }
```
