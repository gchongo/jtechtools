import Component from "@glimmer/component";
import didInsert from "@ember/render-modifiers/modifiers/did-insert";
import willDestroy from "@ember/render-modifiers/modifiers/will-destroy";
import { mountShoutboxDetail, unmountShoutboxDetail } from "../lib/shoutbox-widget";

export default class ShoutboxDetail extends Component {
  widget = null;

  mount = (element) => {
    this.widget = mountShoutboxDetail(element, { id: this.args.id });
  };

  unmount = () => {
    unmountShoutboxDetail(this.widget);
    this.widget = null;
  };

  <template>
    <div class="shoutbox-detail-wrap" {{didInsert this.mount}} {{willDestroy this.unmount}}></div>
  </template>
}
