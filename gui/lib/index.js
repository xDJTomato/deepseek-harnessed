/**
 * 宿主半边:本插件只在浏览器侧渲染悬浮卡片,宿主侧不需要任何行为。
 *
 * 保留一个空 apply() 是客户端插件的标准形态:Loader 行必须能解析到一个模块,
 * 客户端 bundle 再由 dsh-client-modules 依据 package.json 的 dsh.client 声明加载。
 */
/** 宿主侧无行为。 */
function apply() {}

export { apply };
