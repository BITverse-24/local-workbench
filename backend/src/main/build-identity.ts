declare const __WORKBENCH_BUILD_ID__: string;

/** Injected once per desktop build. Source tests cannot stand in for a release build. */
export const BUILD_IDENTITY = typeof __WORKBENCH_BUILD_ID__ === "string" ? __WORKBENCH_BUILD_ID__ : "source-unbundled";
