// The existing authenticated REST boundary; wire keys remain unchanged.
export function createApiClient({ getToken, request }) {
  return async function api(path, options = {}) {
    const response = await request(path, {
      ...options,
      cache: 'no-store',
      headers: { ...options.headers, 'X-EasyADB-Token': getToken().trim() },
    });
    if (!response.ok) {
      let errorBody = {};
      try {
        errorBody = await response.json();
      } catch {
        // Keep the historical generic HTTP error for non-JSON responses.
      }
      throw Error(
        typeof errorBody.detail === 'string'
          ? errorBody.detail
          : '请求失败：HTTP ' + response.status,
      );
    }
    return response;
  };
}
