import ExpoModulesCore
import Vision

// Natywny weryfikator zdjęć dań (benchmark) — Apple Vision, w pełni on-device:
//  • VNClassifyImageRequest — taksonomia obrazu (w tym jedzenie) → etykiety + pewność (food-score liczymy w JS).
//  • VNCalculateImageAestheticsScoresRequest (iOS 18+) — estetyka + `isUtility` (true = grafika/dokument/screenshot/
//    logo, czyli RACZEJ nie zdjęcie dania) → mocny sygnał odsiewu.
// Pobiera remote URL natywnie (jak ML Kit). Działa poza wątkiem głównym. iOS-only (Android: brak modułu → JS pomija).
public class AppleVisionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AppleVision")

    AsyncFunction("analyze") { (url: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        guard let u = URL(string: url), let data = try? Data(contentsOf: u) else {
          promise.resolve(nil); return
        }
        // `data` zachowuje orientację EXIF — handler ją uwzględnia.
        let handler = VNImageRequestHandler(data: data, options: [:])

        var labels: [[String: Any]] = []
        let classify = VNClassifyImageRequest()
        do {
          try handler.perform([classify])
          for o in (classify.results ?? []).prefix(25) where o.confidence > 0.05 {
            labels.append(["text": o.identifier, "confidence": Double(o.confidence)])
          }
        } catch { /* klasyfikacja się nie powiodła — zwrócimy puste etykiety */ }

        var result: [String: Any] = ["labels": labels]
        if #available(iOS 18.0, *) {
          let aesthetics = VNCalculateImageAestheticsScoresRequest()
          if (try? handler.perform([aesthetics])) != nil, let r = aesthetics.results?.first {
            result["aesthetics"] = Double(r.overallScore)
            result["isUtility"] = r.isUtility
          }
        }
        promise.resolve(result)
      }
    }
  }
}
