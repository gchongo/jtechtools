import Component from "@glimmer/component";
import didInsert from "@ember/render-modifiers/modifiers/did-insert";
import willDestroy from "@ember/render-modifiers/modifiers/will-destroy";
import { mountShoutbox, unmountShoutbox } from "../lib/shoutbox-widget";

export default class ShoutboxPage extends Component {
  widget = null;

  mount = (element) => {
    this.widget = mountShoutbox(element, { variant: "page" });
  };

  unmount = () => {
    unmountShoutbox(this.widget);
    this.widget = null;
  };

  <template>
    <div class="shoutbox-page-wrap" {{didInsert this.mount}} {{willDestroy this.unmount}}></div>
  </template>
}
