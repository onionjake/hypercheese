class CurrentUserController < ApplicationController
  def current
    render json: {
      id: current_user&.id,
      username: current_user&.username,
      name: current_user&.name,
      can_write: current_user&.can_write?,
      is_admin: current_user&.is_admin?,
    }
  end
end
