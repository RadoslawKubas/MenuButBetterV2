import ExpoModulesCore
import CoreML
import ImageIO
import CoreGraphics
import CoreVideo

// Natywny weryfikator CLIP (Apple MobileCLIP S0, Core ML, on-device): liczy podobieństwo ZDJĘCIE↔NAZWA dania.
//  • image encoder ma wejście typu „image" → Core ML sam skaluje/normalizuje (podajemy CVPixelBuffer w rozmiarze constraintu).
//  • text encoder ma wejście „już stokenizowane" → tokenizujemy nazwę dania (CLIPTokenizer) na token-id [77].
//  • cosine(embImg, embTxt) ∈ ~[-0.1..0.35]; skalowanie do 0..1 robimy w JS. Modele/tokenizer w zasobach modułu.
public class MobileClipModule: Module {
  private var imageModel: MLModel?
  private var textModel: MLModel?
  private var tokenizer: CLIPTokenizer?
  private var loaded = false
  private var diagInfo: [String: Any] = [:]
  private let loadQueue = DispatchQueue(label: "mobileclip.load")

  public func definition() -> ModuleDefinition {
    Name("MobileClip")

    // DIAGNOSTYKA: co się załadowało (modele/tokenizer) — do podejrzenia, czemu CLIP nie liczy.
    AsyncFunction("diag") { (promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async { self.ensureLoaded(); promise.resolve(self.diagInfo) }
    }

    // Podobieństwo zdjęcie↔tekst (1 etykieta).
    AsyncFunction("match") { (url: String, text: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        self.ensureLoaded()
        guard let imageModel = self.imageModel, let textModel = self.textModel, let tok = self.tokenizer,
              let u = URL(string: url), let data = try? Data(contentsOf: u),
              let imgEmb = self.embedImage(data: data, model: imageModel),
              let txtEmb = self.embedText(ids: tok.encode(text), model: textModel) else {
          promise.resolve(nil); return
        }
        promise.resolve(["score": self.cosine(imgEmb, txtEmb)])
      }
    }

    // Zero-shot klasyfikacja: zdjęcie vs WIELE etykiet → cosine per etykieta (embed obrazu RAZ). Do „czy to menu" itp.
    AsyncFunction("classify") { (url: String, labels: [String], promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        self.ensureLoaded()
        guard let imageModel = self.imageModel, let textModel = self.textModel, let tok = self.tokenizer,
              let u = URL(string: url), let data = try? Data(contentsOf: u),
              let imgEmb = self.embedImage(data: data, model: imageModel) else {
          promise.resolve(nil); return
        }
        var out: [[String: Any]] = []
        for label in labels {
          if let txt = self.embedText(ids: tok.encode(label), model: textModel) {
            out.append(["label": label, "score": self.cosine(imgEmb, txt)])
          }
        }
        promise.resolve(["scores": out])
      }
    }

    // Embedding obrazu (do podobieństwa obraz↔obraz, np. dedup near-duplikatów). Zwraca wektor.
    AsyncFunction("embed") { (url: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        self.ensureLoaded()
        guard let imageModel = self.imageModel,
              let u = URL(string: url), let data = try? Data(contentsOf: u),
              let emb = self.embedImage(data: data, model: imageModel) else {
          promise.resolve(nil); return
        }
        promise.resolve(["embedding": emb.map { Double($0) }])
      }
    }
  }

  private func ensureLoaded() {
    loadQueue.sync {
      if loaded { return }
      loaded = true
      let candidates = [Bundle(for: MobileClipModule.self), Bundle.main]
      func find(_ name: String, _ ext: String) -> URL? {
        for b in candidates {
          if let u = b.url(forResource: name, withExtension: ext) { return u }
          if let rb = b.url(forResource: "MobileClipModels", withExtension: "bundle"), let inner = Bundle(url: rb),
             let u = inner.url(forResource: name, withExtension: ext) { return u }
        }
        return nil
      }
      let cfg = MLModelConfiguration()
      var info: [String: Any] = [:]
      // Ładuj model ODPORNIE: .mlmodelc (skompilowany przy buildzie) ALBO .mlpackage (kompilacja w runtime).
      func loadModel(_ name: String) -> MLModel? {
        if let u = find(name, "mlmodelc") { info["\(name)"] = "mlmodelc"; return try? MLModel(contentsOf: u, configuration: cfg) }
        if let u = find(name, "mlpackage") {
          info["\(name)"] = "mlpackage(compile)"
          if let compiled = try? MLModel.compileModel(at: u) { return try? MLModel(contentsOf: compiled, configuration: cfg) }
          info["\(name)_compileFailed"] = true
          return nil
        }
        info["\(name)"] = "MISSING"
        return nil
      }
      imageModel = loadModel("mobileclip_s0_image")
      textModel = loadModel("mobileclip_s0_text")
      let vu = find("vocab", "json"), mu = find("merges", "txt")
      if let vu = vu, let mu = mu { tokenizer = CLIPTokenizer(vocabURL: vu, mergesURL: mu) }
      info["tokenizerFiles"] = (vu != nil && mu != nil)
      info["imageModelOK"] = (imageModel != nil)
      info["textModelOK"] = (textModel != nil)
      info["tokenizerOK"] = (tokenizer != nil)
      self.diagInfo = info
    }
  }

  // Obraz: wejście typu image → CVPixelBuffer w rozmiarze constraintu modelu.
  private func embedImage(data: Data, model: MLModel) -> [Float]? {
    guard let inputName = model.modelDescription.inputDescriptionsByName.keys.first,
          let constraint = model.modelDescription.inputDescriptionsByName[inputName]?.imageConstraint,
          let src = CGImageSourceCreateWithData(data as CFData, nil),
          let cg = CGImageSourceCreateImageAtIndex(src, 0, nil),
          let pb = pixelBuffer(from: cg, width: constraint.pixelsWide, height: constraint.pixelsHigh),
          let fv = try? MLFeatureValue(pixelBuffer: pb),
          let provider = try? MLDictionaryFeatureProvider(dictionary: [inputName: fv]),
          let out = try? model.prediction(from: provider) else { return nil }
    return firstVector(out)
  }

  // Tekst: token-id → MLMultiArray wg dataType/shape modelu.
  private func embedText(ids: [Int], model: MLModel) -> [Float]? {
    guard let inputName = model.modelDescription.inputDescriptionsByName.keys.first,
          let con = model.modelDescription.inputDescriptionsByName[inputName]?.multiArrayConstraint,
          let m = try? MLMultiArray(shape: con.shape, dataType: con.dataType) else { return nil }
    let total = con.shape.map { $0.intValue }.reduce(1, *)
    for i in 0..<min(total, ids.count) { m[i] = NSNumber(value: Int32(ids[i])) }
    guard let provider = try? MLDictionaryFeatureProvider(dictionary: [inputName: MLFeatureValue(multiArray: m)]),
          let out = try? model.prediction(from: provider) else { return nil }
    return firstVector(out)
  }

  private func firstVector(_ out: MLFeatureProvider) -> [Float]? {
    for name in out.featureNames {
      if let ma = out.featureValue(for: name)?.multiArrayValue {
        var v = [Float](repeating: 0, count: ma.count)
        for i in 0..<ma.count { v[i] = ma[i].floatValue }
        return v
      }
    }
    return nil
  }

  private func cosine(_ a: [Float], _ b: [Float]) -> Double {
    let n = min(a.count, b.count)
    var dot: Float = 0, na: Float = 0, nb: Float = 0
    for i in 0..<n { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    if na == 0 || nb == 0 { return 0 }
    return Double(dot / (sqrt(na) * sqrt(nb)))
  }

  private func pixelBuffer(from cg: CGImage, width: Int, height: Int) -> CVPixelBuffer? {
    let attrs: [String: Any] = [
      kCVPixelBufferCGImageCompatibilityKey as String: true,
      kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
    ]
    var pb: CVPixelBuffer?
    CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pb)
    guard let buffer = pb else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let ctx = CGContext(
      data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height,
      bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ) else { return nil }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
    return buffer
  }
}
