import Component from "@glimmer/component";
import didInsert from "@ember/render-modifiers/modifiers/did-insert";
import willDestroy from "@ember/render-modifiers/modifiers/will-destroy";
import { mountShoutboxDetail, unmountShoutboxDetail } from "../lib/shoutbox-widget";

export default class ShoutboxDetail extends Component {
  widget = null;

  mount = (element) => {
    // read the id straight from the URL — route-model plumbing through gjs
    // template args proved unreliable (arrived undefined -> NaN.json)
    const id = Number(window.location.pathname.match(/\/shoutbox\/m\/(\d+)/)?.[1]);
    this.widget = mountShoutboxDetail(element, { id });
  };

  unmount = () => {
    unmountShoutboxDetail(this.widget);
    this.widget = null;
  };

  <template>
    <div class="shoutbox-detail-wrap" {{didInsert this.mount}} {{willDestroy this.unmount}}></div>
  </template>
}
