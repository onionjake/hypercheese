class User::SessionsController < Devise::SessionsController
  skip_before_filter :verify_approval!

  def choose
  end

end
