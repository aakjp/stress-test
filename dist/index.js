// index.ts
import { WasmClient } from "rust-fetch";
// One configured client: 10s timeout, up to 2 retries with backoff
const client = new WasmClient({
    timeoutMs: 10_000,
    retries: { maxRetries: 2, retryOnNetworkError: true },
});
async function fetchUsers() {
    const url = "https://jsonplaceholder.typicode.com/users";
    try {
        // 1. Make the GET request
        const response = await client.get(url);
        // 2. Check the status
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        // 3. The body is already parsed (JSON Content-Type)
        const users = response.body;
        console.log(`Successfully fetched ${users.length} users:`);
        users.forEach((user) => {
            console.log(`- ID: ${user.id}, Name: ${user.name}, Email: ${user.email}`);
        });
    }
    catch (error) {
        console.error("Failed to fetch users:", error instanceof Error ? error.message : String(error));
    }
}
// Execute the function
fetchUsers();
//# sourceMappingURL=index.js.map