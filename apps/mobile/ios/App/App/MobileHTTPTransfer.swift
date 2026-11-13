import Foundation

struct MobileHTTPResponse {
    let status: Int
    let headers: [String: String]
    let data: Data
}

/// Bounded, cookie-free requests. Redirects are never followed with native credentials.
final class MobileHTTPTransfer: NSObject, URLSessionDataDelegate {
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var data = Data()
    private var response: HTTPURLResponse?
    private var completion: ((Result<MobileHTTPResponse, MobileBridgeError>) -> Void)?
    private var timer: Timer?
    private let limit: Int

    init(request: URLRequest, limit: Int = MobileRequestPolicy.responseLimit,
         completion: @escaping (Result<MobileHTTPResponse, MobileBridgeError>) -> Void) {
        self.limit = limit
        self.completion = completion
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 30
        session = URLSession(configuration: config, delegate: self, delegateQueue: OperationQueue.main)
        task = session?.dataTask(with: request)
    }

    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in self?.finish(.failure(.network)) }
        task?.resume()
    }

    func cancel(_ reason: MobileBridgeError = .cancelled) { finish(.failure(reason)) }

    private func finish(_ result: Result<MobileHTTPResponse, MobileBridgeError>) {
        guard let completion else { return }
        self.completion = nil
        timer?.invalidate()
        timer = nil
        task?.cancel()
        session?.invalidateAndCancel()
        session = nil
        task = nil
        data.removeAll(keepingCapacity: false)
        completion(result)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse else {
            completionHandler(.cancel); finish(.failure(.network)); return
        }
        guard response.expectedContentLength <= Int64(limit) else {
            completionHandler(.cancel); finish(.failure(.responseTooLarge)); return
        }
        self.response = response
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        guard chunk.count <= limit - data.count else { finish(.failure(.responseTooLarge)); return }
        data.append(chunk)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard error == nil, let response else { finish(.failure(.network)); return }
        var headers = [String: String]()
        for (key, value) in response.allHeaderFields {
            guard let name = key as? String, MobileRequestPolicy.responseHeaders.contains(name.lowercased()) else { continue }
            let text = String(describing: value)
            if text.utf8.count <= 16384 { headers[name.lowercased()] = text }
        }
        finish(.success(MobileHTTPResponse(status: response.statusCode, headers: headers, data: data)))
    }
}
