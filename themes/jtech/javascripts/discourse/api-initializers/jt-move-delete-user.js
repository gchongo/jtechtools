import { apiInitializer } from "discourse/lib/api";

export default apiInitializer("1.0", (api) => {
  const move = () => {
    // Delete 下拉所在的容器（核心渲染在 .secondary 统计区里）
    const source = document.querySelector(
      ".user-main .secondary dl > .pull-right"
    );
    const ul = document.querySelector(".user-main .about .controls ul");
    if (!source || !ul) {
      return;
    }
    if (source.closest(".controls")) {
      return; // 已经搬过了
    }
    // 清掉 Ember 重渲染可能留下的旧拷贝，防止重复
    ul.querySelectorAll("li.delete-user-row").forEach((n) => n.remove());

    const li = document.createElement("li");
    li.className = "delete-user-row";
    li.appendChild(source);
    ul.appendChild(li); // 追加到末尾 = Unfollow/Chat 后面
  };

  api.onPageChange(() => requestAnimationFrame(move));

  // Ember 局部重渲染（比如点 Follow 刷新按钮区）会把 DOM 复原，靠它自动重搬
  const observer = new MutationObserver(move);
  observer.observe(document.body, { childList: true, subtree: true });
});
