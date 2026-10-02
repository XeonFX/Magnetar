//! Helpers shared by the integration tests.

/// A valid single-file .torrent of exactly `size` bytes, named `name`, padded with a comment
/// (outside the info dictionary, so the name alone sets the info hash).
pub fn torrent_of_size(size: usize, name: &str) -> Vec<u8> {
    const PIECE: usize = 16 * 1024;
    let info = |pieces: usize| {
        let mut info =
            format!("d6:lengthi{}e4:name{}:{name}12:piece lengthi{PIECE}e6:pieces{}:", pieces * PIECE, name.len(), pieces * 20)
                .into_bytes();
        info.extend((0..pieces * 20).map(|i| (i * 7 + name.len()) as u8));
        info.push(b'e');
        info
    };
    let wrap = |info: &[u8], comment: usize| {
        let mut torrent = format!("d7:comment{comment}:{}4:info", "x".repeat(comment)).into_bytes();
        torrent.extend_from_slice(info);
        torrent.push(b'e');
        torrent
    };
    let pieces = (size.saturating_sub(200) / 20).max(1);
    let info = info(pieces);
    let mut comment = size.saturating_sub(wrap(&info, 0).len());
    // The comment's length prefix grows with it: settle on the length that lands exactly.
    while wrap(&info, comment).len() > size {
        comment -= 1;
    }
    let torrent = wrap(&info, comment);
    assert_eq!(torrent.len(), size, "no comment length gives exactly {size} bytes");
    torrent
}
