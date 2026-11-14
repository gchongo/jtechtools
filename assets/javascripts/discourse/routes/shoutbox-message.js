import DiscourseRoute from "discourse/routes/discourse";
import { i18n } from "discourse-i18n";

export default class ShoutboxMessageRoute extends DiscourseRoute {
  titleToken() {
    return i18n("shoutbox.title");
  }

  model(params) {
    return { id: params.id };
  }
}
