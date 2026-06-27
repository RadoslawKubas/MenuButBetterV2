import Foundation

// Tokenizer CLIP (BPE) — port kanonicznego OpenAI SimpleTokenizer (ten sam, którego używa MobileCLIP). Wczytuje
// vocab.json (token→id) + merges.txt (reguły BPE). Tekst → token-id [77] (z <|startoftext|>/<|endoftext|>, pad 0).
// Uproszczone czyszczenie tekstu (lowercase + whitespace) — wystarczy dla krótkich nazw dań.
final class CLIPTokenizer {
  private var encoder: [String: Int] = [:]
  private var bpeRanks: [String: Int] = [:]
  private var byteEncoder: [UInt8: String] = [:]
  private let sot = 49406, eot = 49407, contextLength = 77
  // Regex jak w CLIP (uproszczony: litery / cyfry / reszta nie-białych) + apostrofowe końcówki.
  private let pat = try! NSRegularExpression(pattern: "'s|'t|'re|'ve|'m|'ll|'d|[\\p{L}]+|[\\p{N}]|[^\\s\\p{L}\\p{N}]+", options: [.caseInsensitive])

  init?(vocabURL: URL, mergesURL: URL) {
    // byte→unicode (trik GPT-2): widoczne bajty zostają, reszta mapowana na obszar 256+ .
    var bs: [Int] = Array(33...126) + Array(161...172) + Array(174...255)
    var cs = bs
    var n = 0
    for b in 0...255 where !bs.contains(b) { bs.append(b); cs.append(256 + n); n += 1 }
    for (b, c) in zip(bs, cs) { byteEncoder[UInt8(b)] = String(UnicodeScalar(c)!) }

    guard let vData = try? Data(contentsOf: vocabURL),
          let vocab = (try? JSONSerialization.jsonObject(with: vData)) as? [String: Int] else { return nil }
    encoder = vocab
    guard let merges = try? String(contentsOf: mergesURL, encoding: .utf8) else { return nil }
    var rank = 0
    for line in merges.split(separator: "\n") {
      let t = line.trimmingCharacters(in: .whitespaces)
      if t.isEmpty || t.hasPrefix("#") { continue }
      bpeRanks[t] = rank; rank += 1
    }
  }

  private func getPairs(_ word: [String]) -> Set<String> {
    var pairs = Set<String>()
    for i in 0..<max(0, word.count - 1) { pairs.insert(word[i] + " " + word[i + 1]) }
    return pairs
  }

  private func bpe(_ token: String) -> [String] {
    // token (już byte-encoded) → znaki, do ostatniego doklej "</w>".
    var word = token.map { String($0) }
    if word.isEmpty { return [] }
    word[word.count - 1] = word[word.count - 1] + "</w>"
    var pairs = getPairs(word)
    if pairs.isEmpty { return [token + "</w>"] }
    while true {
      // wybierz parę o najniższej randze
      var minRank = Int.max
      var best: String? = nil
      for p in pairs { if let r = bpeRanks[p], r < minRank { minRank = r; best = p } }
      guard let bigram = best else { break }
      let parts = bigram.split(separator: " ").map(String.init)
      let first = parts[0], second = parts[1]
      var newWord: [String] = []
      var i = 0
      while i < word.count {
        if let j = (i..<word.count).first(where: { word[$0] == first }) {
          newWord.append(contentsOf: word[i..<j]); i = j
        } else { newWord.append(contentsOf: word[i...]); break }
        if word[i] == first && i + 1 < word.count && word[i + 1] == second {
          newWord.append(first + second); i += 2
        } else { newWord.append(word[i]); i += 1 }
      }
      word = newWord
      if word.count == 1 { break }
      pairs = getPairs(word)
    }
    return word
  }

  /// Tekst → token-id stałej długości 77 (sot + bpe + eot, pad 0, truncate).
  func encode(_ text: String) -> [Int] {
    let clean = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
    var ids: [Int] = [sot]
    let ns = clean as NSString
    for m in pat.matches(in: clean, range: NSRange(location: 0, length: ns.length)) {
      let tok = ns.substring(with: m.range)
      // byte-encode (UTF-8 bajty → unicode)
      var enc = ""
      for b in Array(tok.utf8) { enc += byteEncoder[b] ?? "" }
      for sub in bpe(enc) { if let id = encoder[sub] { ids.append(id) } }
    }
    ids.append(eot)
    if ids.count > contextLength { ids = Array(ids.prefix(contextLength)); ids[contextLength - 1] = eot }
    while ids.count < contextLength { ids.append(0) }
    return ids
  }
}
